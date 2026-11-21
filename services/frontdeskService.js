// FrontDeskFlow ⇄ RoomCare room integration (served under /api/integrations/frontdesk).
//
//   FrontDeskFlow → RoomCare   room sync (create / update), guest check-out
//   RoomCare → FrontDeskFlow   room status updates and cleaned rooms (read by FrontDeskFlow, plus the outgoing
//                              CleaningCompleted push queued by services/pmsIntegrationService.js)
//
// Two separate statuses are kept apart in everything returned here:
//   housekeepingStatus  Dirty | In Progress | Clean | Inspected   — owned by RoomCare
//   occupancyStatus     Occupied | Vacant                          — owned by FrontDeskFlow
// Finishing a cleaning never sets a room Vacant: RoomCare only reports that housekeeping is done.
// RoomCare's single Room.status column holds both concerns, so they are derived from it here (no schema change).
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Room, CleaningTask, IntegrationEvent, User } from "../models/index.js";
import { RoomStatus, TaskStatus, ACTIVE_TASK_STATUSES, IntegrationStatus as S, housekeepingStatus as taskLabel } from "../models/enums.js";
import { PMS } from "../config/integrations.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { handleRoomVacated } from "./pmsIntegrationService.js";

const ID = /^[A-Za-z0-9._:\-/]{1,100}$/;
const ROOM_NO = /^[A-Za-z0-9-]{1,20}$/;
const HOUSEKEEPING = { dirty: RoomStatus.VACANT_DIRTY, clean: RoomStatus.VACANT_CLEAN, inspected: RoomStatus.INSPECTED };
const iso = (d) => (d ? new Date(d).toISOString() : null);

export const housekeepingOf = (room) => ({
  [RoomStatus.VACANT_DIRTY]: "Dirty",
  [RoomStatus.CLEANING]: "In Progress",
  [RoomStatus.VACANT_CLEAN]: "Clean",
  [RoomStatus.INSPECTED]: "Inspected",
}[room.status] ?? null); // occupied / out-of-order rooms have no current housekeeping state

export const occupancyOf = (room) => (room.status === RoomStatus.OCCUPIED ? "Occupied" : "Vacant");

const roomDto = (room, openTask = null) => ({
  externalRoomId: room.externalId,
  roomCareRoomId: room.id,
  roomNumber: room.roomNo,
  roomType: room.type,
  floor: room.floor,
  description: room.description ?? null,
  housekeepingStatus: housekeepingOf(room),
  occupancyStatus: occupancyOf(room),
  outOfOrder: room.status === RoomStatus.OUT_OF_ORDER,
  openCleaningTask: openTask ? { taskCode: openTask.code, status: openTask.status, statusLabel: taskLabel(openTask) } : null,
  lastSyncedAt: iso(room.externalSyncedAt),
  updatedAt: iso(room.updatedAt),
});

const withOpenTasks = async (rooms) => {
  const tasks = rooms.length
    ? await CleaningTask.findAll({ where: { roomId: rooms.map((r) => r.id), status: ACTIVE_TASK_STATUSES }, order: [["id", "ASC"]] })
    : [];
  const byRoom = new Map(tasks.map((t) => [t.roomId, t]));
  return rooms.map((r) => roomDto(r, byRoom.get(r.id)));
};

// ── Validation ────────────────────────────────────────────────────────────────────────────────────

const fail = (errors) => { throw new AppError("Validation failed", 422, errors); };

const parseOccupancy = (v) => {
  const s = String(v).trim().toLowerCase();
  return s === "occupied" ? "Occupied" : s === "vacant" ? "Vacant" : null;
};

// partial=true (PUT): every field optional. Returns only the fields that were sent.
const validateRoomBody = (body, { partial }) => {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : fail([{ field: "body", message: "A JSON object is required" }]);
  const errors = [];
  const out = {};
  const has = (k) => b[k] !== undefined && b[k] !== null;
  const required = (k) => { if (!partial && !has(k)) errors.push({ field: k, message: "is required" }); return has(k); };

  if (required("externalRoomId") && !partial) {
    if (!ID.test(String(b.externalRoomId))) errors.push({ field: "externalRoomId", message: "must be 1–100 characters: letters, digits, . _ : - /" });
    else out.externalId = String(b.externalRoomId);
  }
  if (required("roomNumber")) {
    if (!ROOM_NO.test(String(b.roomNumber))) errors.push({ field: "roomNumber", message: "must be 1–20 characters: letters, digits, -" });
    else out.roomNo = String(b.roomNumber);
  }
  const typeKey = has("roomType") ? "roomType" : "type";
  if (!partial && !has("roomType") && !has("type")) errors.push({ field: "roomType", message: "is required" });
  if (has(typeKey)) {
    const t = String(b[typeKey] ?? "").trim();
    if (!t || t.length > 100) errors.push({ field: "roomType", message: "must be 1–100 characters" });
    else out.type = t;
  }
  if (required("floor")) {
    const f = Number(b.floor);
    if (!Number.isInteger(f) || f < 0 || f > 200) errors.push({ field: "floor", message: "must be a whole number from 0 to 200" });
    else out.floor = f;
  }
  if (has("description")) {
    if (typeof b.description !== "string" || b.description.length > 2000) errors.push({ field: "description", message: "must be text up to 2000 characters" });
    else out.description = b.description.trim() || null;
  }
  const occ = b.occupancyStatus ?? b.roomStatus ?? b.status;
  if (occ !== undefined && occ !== null) {
    out.occupancy = parseOccupancy(occ);
    if (!out.occupancy) errors.push({ field: "roomStatus", message: 'must be "Occupied" or "Vacant" (occupancy; housekeeping status is owned by RoomCare)' });
  }
  if (has("housekeepingStatus")) {
    if (!HOUSEKEEPING[String(b.housekeepingStatus).toLowerCase()]) errors.push({ field: "housekeepingStatus", message: 'must be "Dirty", "Clean" or "Inspected"' });
    else out.housekeeping = String(b.housekeepingStatus).toLowerCase();
  }
  if (partial && !Object.keys(out).length && !errors.length) errors.push({ field: "body", message: "No updatable field was sent" });
  if (errors.length) fail(errors);
  return out;
};

const eventIdOf = (body, key) => {
  const id = body?.eventId ?? key;
  if (id === undefined || id === null || id === "") return null;
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(String(id))) fail([{ field: "eventId", message: "must be 1–100 characters: letters, digits, . _ : -" }]);
  return String(id);
};

// Records an idempotency key for a room event. Returns true when the key was already used.
const alreadySeen = async (eventType, eventId, payload) => {
  if (!eventId) return false;
  try {
    await IntegrationEvent.create({ system: "PMS", direction: "IN", eventType, eventId, payload, status: S.PROCESSED, occurredAt: new Date(), processedAt: new Date() });
    return false;
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    await IntegrationEvent.increment("duplicateCount", { where: { system: "PMS", direction: "IN", eventId } });
    return true;
  }
};

const findByExternal = async (externalRoomId, opts = {}) => {
  const room = await Room.findOne({ where: { externalId: String(externalRoomId) }, ...opts });
  if (!room) throw new AppError(`Room ${externalRoomId} has not been synchronized`, 404);
  return room;
};

// ── Room synchronization ──────────────────────────────────────────────────────────────────────────

// POST /rooms. Returns { created, linked, room }. Sending the same room again is not an error: it returns the
// existing record (created: false). A room entered by hand in RoomCare with the same number is linked, not duplicated.
export const syncRoom = async (body, idempotencyKey) => {
  const data = validateRoomBody(body, { partial: false });
  const eventId = eventIdOf(body, idempotencyKey);
  if (await alreadySeen("RoomSynced", eventId, body)) {
    return { created: false, linked: false, duplicate: true, room: roomDto(await findByExternal(data.externalId)) };
  }

  const run = () => sequelize.transaction(async (transaction) => {
    const existing = await Room.findOne({ where: { externalId: data.externalId }, transaction });
    if (existing) return { created: false, linked: false, room: existing };

    const sameNumber = await Room.findOne({ where: { roomNo: data.roomNo }, transaction });
    if (sameNumber?.externalId) throw new AppError(`Room number ${data.roomNo} already belongs to front-desk room ${sameNumber.externalId}`, 409);
    if (sameNumber) {
      await sameNumber.update({ externalId: data.externalId, externalSyncedAt: new Date(), description: data.description ?? sameNumber.description }, { transaction });
      return { created: false, linked: true, room: sameNumber };
    }
    const status = data.occupancy === "Occupied" ? RoomStatus.OCCUPIED : HOUSEKEEPING[data.housekeeping || "clean"];
    const room = await Room.create({
      roomNo: data.roomNo, type: data.type, floor: data.floor, description: data.description ?? null,
      externalId: data.externalId, externalSyncedAt: new Date(), status,
      pmsStatus: (data.occupancy || "Vacant").toUpperCase(), pmsStatusAt: new Date(),
    }, { transaction });
    return { created: true, linked: false, room };
  });

  // Concurrent identical requests race on the unique keys: the loser either hits a unique violation or a
  // MySQL deadlock, and in both cases the right answer is to look the room up again.
  let result;
  try {
    result = await run().catch((err) => (err?.parent?.code === "ER_LOCK_DEADLOCK" ? run() : Promise.reject(err)));
  } catch (err) {
    if (!(err instanceof UniqueConstraintError) && err?.parent?.code !== "ER_LOCK_DEADLOCK") throw err;
    result = { created: false, linked: false, room: await Room.findOne({ where: { externalId: data.externalId } }) }; // lost a race
    if (!result.room) throw new AppError(`Room number ${data.roomNo} already exists`, 409);
  }
  const { room } = result;
  if (result.created || result.linked) {
    await logAction(null, result.created ? "FRONTDESK_ROOM_CREATE" : "FRONTDESK_ROOM_LINK", "Room", room.id, `Room ${room.roomNo} ← front-desk room ${room.externalId}`);
  }
  return { ...result, room: roomDto(room) };
};

// PUT /rooms/:externalRoomId — partial update. housekeepingStatus is ignored: RoomCare owns it.
export const updateSyncedRoom = async (externalRoomId, body, idempotencyKey) => {
  const data = validateRoomBody(body, { partial: true });
  const eventId = eventIdOf(body, idempotencyKey);
  if (await alreadySeen("RoomUpdated", eventId, body)) return { duplicate: true, room: roomDto(await findByExternal(externalRoomId)) };

  try {
    const room = await sequelize.transaction(async (transaction) => {
      const room = await findByExternal(externalRoomId, { transaction, lock: transaction.LOCK.UPDATE });
      if (data.roomNo && data.roomNo !== room.roomNo) {
        const clash = await Room.findOne({ where: { roomNo: data.roomNo, id: { [Op.ne]: room.id } }, transaction });
        if (clash) throw new AppError(`Room number ${data.roomNo} is already used by another room`, 409);
      }
      const changes = { externalSyncedAt: new Date() };
      for (const k of ["roomNo", "type", "floor", "description"]) if (data[k] !== undefined) changes[k] = data[k];

      if (data.occupancy === "Occupied" && room.status !== RoomStatus.OCCUPIED) {
        if (room.status === RoomStatus.CLEANING) throw new AppError(`Room ${room.roomNo} is being cleaned and cannot be marked occupied yet`, 409);
        if (room.status !== RoomStatus.OUT_OF_ORDER) changes.status = RoomStatus.OCCUPIED;
      }
      if (data.occupancy === "Vacant" && room.status === RoomStatus.OCCUPIED) {
        throw new AppError(`Room ${room.roomNo} is occupied in RoomCare. Send a checkout event to vacate it so housekeeping is triggered`, 409);
      }
      if (data.occupancy) Object.assign(changes, { pmsStatus: data.occupancy.toUpperCase(), pmsStatusAt: new Date() });
      await room.update(changes, { transaction });
      return room;
    });
    await logAction(null, "FRONTDESK_ROOM_UPDATE", "Room", room.id, `Room ${room.roomNo} updated from front-desk room ${room.externalId}`);
    return { duplicate: false, ignored: data.housekeeping ? ["housekeepingStatus"] : [], room: roomDto(room) };
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw new AppError("Room number is already used by another room", 409);
    throw err;
  }
};

export const getSyncedRoom = async (externalRoomId) => {
  const room = await findByExternal(externalRoomId);
  return (await withOpenTasks([room]))[0];
};

const pageOf = (q) => ({
  limit: Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200),
  offset: Math.max(parseInt(q.offset, 10) || 0, 0),
});
export const parseSince = (v, field = "since") => {
  if (v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail([{ field, message: "must be an ISO-8601 date or timestamp" }]);
  return d;
};

// GET /rooms?housekeeping_status=&occupancy_status=&floor=&updated_since=&limit=&offset=
export const listSyncedRooms = async (q) => {
  const { limit, offset } = pageOf(q);
  const where = { externalId: { [Op.ne]: null } };
  const errors = [];
  if (q.floor !== undefined) Number.isInteger(Number(q.floor)) ? (where.floor = Number(q.floor)) : errors.push({ field: "floor", message: "must be a whole number" });
  if (q.housekeeping_status !== undefined) {
    const s = { dirty: RoomStatus.VACANT_DIRTY, "in progress": RoomStatus.CLEANING, in_progress: RoomStatus.CLEANING, ...HOUSEKEEPING }[String(q.housekeeping_status).toLowerCase()];
    s ? (where.status = s) : errors.push({ field: "housekeeping_status", message: "must be Dirty, In Progress, Clean or Inspected" });
  }
  if (q.occupancy_status !== undefined) {
    const o = parseOccupancy(q.occupancy_status);
    if (!o) errors.push({ field: "occupancy_status", message: 'must be "Occupied" or "Vacant"' });
    else if (where.status) { if ((o === "Occupied") !== (where.status === RoomStatus.OCCUPIED)) where.id = 0; }
    else where.status = o === "Occupied" ? RoomStatus.OCCUPIED : { [Op.ne]: RoomStatus.OCCUPIED };
  }
  if (errors.length) fail(errors);
  const updatedSince = parseSince(q.updated_since, "updated_since");
  if (updatedSince) where.updatedAt = { [Op.gte]: updatedSince };
  const { rows, count } = await Room.findAndCountAll({ where, order: [["floor", "ASC"], ["roomNo", "ASC"]], limit, offset });
  return { items: await withOpenTasks(rows), meta: { total: count, limit, offset } };
};

// ── Guest check-out ───────────────────────────────────────────────────────────────────────────────

// POST /checkout — the room becomes Dirty and one cleaning task exists for it, however often the event is sent.
// Reuses the PMS RoomVacated handler, which provides the event-id idempotency and the one-open-task-per-room rule.
export const handleCheckout = async (body, idempotencyKey) => {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : fail([{ field: "body", message: "A JSON object is required" }]);
  const errors = [];
  const eventId = eventIdOf(b, idempotencyKey);
  if (!eventId) errors.push({ field: "eventId", message: "is required (or send an Idempotency-Key header)" });
  if (!b.externalRoomId && !b.roomNumber) errors.push({ field: "externalRoomId", message: "externalRoomId or roomNumber is required" });
  if (b.externalRoomId && !ID.test(String(b.externalRoomId))) errors.push({ field: "externalRoomId", message: "is not a valid id" });
  if (b.roomNumber && !ROOM_NO.test(String(b.roomNumber))) errors.push({ field: "roomNumber", message: "is not a valid room number" });
  const occurredAt = b.occurredAt === undefined ? new Date() : new Date(b.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) errors.push({ field: "occurredAt", message: "must be an ISO-8601 timestamp" });
  if (errors.length) fail(errors);

  const room = b.externalRoomId
    ? await findByExternal(b.externalRoomId)
    : await Room.findOne({ where: { roomNo: String(b.roomNumber) } }) || (() => { throw new AppError(`Room ${b.roomNumber} not found`, 404); })();
  if (b.externalRoomId && b.roomNumber && String(b.roomNumber) !== room.roomNo) {
    throw new AppError(`roomNumber ${b.roomNumber} does not match room ${b.externalRoomId} (${room.roomNo})`, 409);
  }

  const result = await handleRoomVacated({ ...b, eventType: "RoomVacated", eventId, roomNo: room.roomNo, occurredAt: occurredAt.toISOString() });
  if (!result.duplicate) {
    // FrontDeskFlow reports the guest has left, so its occupancy is Vacant as of this event.
    if (!room.pmsStatusAt || room.pmsStatusAt <= occurredAt) await room.update({ pmsStatus: "VACANT", pmsStatusAt: occurredAt });
  }
  await room.reload();
  return {
    eventId, duplicate: Boolean(result.duplicate), taskCreated: Boolean(result.taskCreated),
    task: result.task ? { taskCode: result.task.code, status: result.task.status } : null,
    room: roomDto(room),
  };
};

// ── RoomCare → FrontDeskFlow (read by FrontDeskFlow) ──────────────────────────────────────────────

// GET /room-status-updates?after_id=&since=&delivery_status=&limit=
// The outgoing CleaningCompleted notifications RoomCare has prepared, oldest first. Poll with after_id=<nextCursor>.
export const roomStatusUpdates = async (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const afterId = Math.max(parseInt(q.after_id, 10) || 0, 0);
  const where = { system: "PMS", direction: "OUT", id: { [Op.gt]: afterId } };
  const since = parseSince(q.since);
  if (since) where.createdAt = { [Op.gte]: since };
  if (q.delivery_status !== undefined) {
    const s = String(q.delivery_status).toUpperCase();
    if (!["PENDING", "SENDING", "SENT", "FAILED"].includes(s)) fail([{ field: "delivery_status", message: "must be PENDING, SENDING, SENT or FAILED" }]);
    where.status = s;
  }
  const rows = await IntegrationEvent.findAll({ where, order: [["id", "ASC"]], limit });
  const items = rows.map((e) => ({
    updateId: e.id, eventId: e.eventId, eventType: e.eventType, occurredAt: iso(e.occurredAt),
    delivery: {
      status: e.status, attempts: e.attempts, deliveredAt: e.status === S.SENT ? iso(e.processedAt) : null,
      lastError: e.lastError, mode: PMS.mode,
    },
    payload: e.payload,
  }));
  return { items, meta: { limit, nextCursor: rows.length ? rows[rows.length - 1].id : afterId, hasMore: rows.length === limit } };
};

// GET /cleaned-rooms?since=&housekeeping_status=Clean|Inspected&limit=&offset=
// Rooms whose housekeeping is finished and which are currently Clean or Inspected, with the task that cleaned them.
export const cleanedRooms = async (q) => {
  const { limit, offset } = pageOf(q);
  const since = parseSince(q.since);
  const wanted = q.housekeeping_status === undefined ? [RoomStatus.VACANT_CLEAN, RoomStatus.INSPECTED] : [HOUSEKEEPING[String(q.housekeeping_status).toLowerCase()]];
  if (!wanted[0] || wanted[0] === RoomStatus.VACANT_DIRTY) fail([{ field: "housekeeping_status", message: "must be Clean or Inspected" }]);

  const tasks = await CleaningTask.findAll({
    where: { status: [TaskStatus.DONE, TaskStatus.INSPECTED], completedAt: since ? { [Op.gte]: since } : { [Op.ne]: null } },
    include: [
      { model: Room, as: "room", where: { status: wanted } },
      { model: User, as: "housekeeper", attributes: ["name"] },
    ],
    order: [["completedAt", "DESC"], ["id", "DESC"]],
    limit: 2000,
  });
  const latest = new Map();
  for (const t of tasks) if (!latest.has(t.roomId)) latest.set(t.roomId, t);
  const all = [...latest.values()];
  return {
    items: all.slice(offset, offset + limit).map((t) => ({
      ...roomDto(t.room),
      cleaningCompletedAt: iso(t.completedAt),
      verifiedAt: iso(t.inspectedAt),
      taskCode: t.code,
      completedBy: t.housekeeper?.name ?? null,
      // Housekeeping is done, but only the front desk can confirm no guest is assigned before reselling the room.
      note: "housekeepingStatus is not availability; FrontDeskFlow confirms occupancy",
    })),
    meta: { total: all.length, limit, offset },
  };
};
