// Room synchronization with FrontDeskFlow (FrontDeskFlow → RoomCare), using
//   GET /housekeeping/rooms and GET /housekeeping/rooms/{roomNumber}
//
// FrontDeskFlow is the source of truth for room records, so rooms that exist there are created or updated here without
// anyone adding them by hand. RoomCare owns housekeeping, so a sync NEVER overwrites a room's housekeeping status
// (Dirty / Cleaning / Clean / Vacant Room). The only status the sync ever changes is occupancy:
//   • FrontDeskFlow says Occupied  → RoomCare marks the room Occupied (unless it is being cleaned or out of order)
//   • FrontDeskFlow says Vacant while RoomCare has it Occupied → that is a confirmed check-out: the standard RoomVacated
//     handling makes the room Dirty and creates ONE cleaning task. Vacant rooms are never made Dirty on their own.
// Check-out detection only works when the room response has an occupancy field mapped (FRONTDESK_ROOM_MAP.occupancy).
import { Op } from "sequelize";
import { sequelize, Room, IntegrationEvent } from "../models/index.js";
import { RoomStatus, IntegrationStatus as S } from "../models/enums.js";
import { PMS, FRONTDESK_API } from "../config/integrations.js";
import { ROOM_MAP, mappingProblems, normalizeRoom, getPath } from "../config/frontdeskApiMapping.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { handleRoomVacated } from "./pmsIntegrationService.js";
import * as api from "./frontdeskApiClient.js";

const ROOM_NO = /^[A-Za-z0-9-]{1,20}$/;
const MAX_LISTED_ERRORS = 50;
const OCCUPIABLE = [RoomStatus.VACANT_CLEAN, RoomStatus.INSPECTED, RoomStatus.VACANT_DIRTY];

let running = false;
let lastSync = null;
export const frontdeskSyncStatus = () => ({ running, last: lastSync });

// Writes one room's data. Returns { action: created|linked|updated|unchanged, checkedOut, warning? }.
const applyRoom = async (n, now) => {
  let action = "unchanged";
  let checkout = false;
  let warning = null;
  let roomNo = n.roomNumber;

  await sequelize.transaction(async (transaction) => {
    const lock = transaction.LOCK.UPDATE;
    let room = await Room.findOne({ where: { externalId: n.externalId }, transaction, lock });
    const matchedByExternalId = Boolean(room);
    if (!room) {
      room = await Room.findOne({ where: { roomNo: n.roomNumber }, transaction, lock });
      if (room?.externalId && room.externalId !== n.externalId) {
        throw new Error(`room number ${n.roomNumber} is already linked to FrontDeskFlow room ${room.externalId}`);
      }
    }

    if (!room) {
      const missing = [];
      if (!n.type) missing.push("type");
      if (n.floor === undefined) missing.push("floor");
      if (missing.length) throw new Error(`cannot create room ${n.roomNumber}: FrontDeskFlow gave no ${missing.join(" / ")} (map it, or set defaultType / defaultFloor in FRONTDESK_ROOM_MAP)`);
      await Room.create({
        roomNo: n.roomNumber, type: n.type, floor: n.floor, description: n.description ?? null,
        status: n.occupancy === "Occupied" ? RoomStatus.OCCUPIED : n.needsCleaning ? RoomStatus.VACANT_DIRTY : RoomStatus.VACANT_CLEAN,
        externalId: n.externalId, externalSyncedAt: now,
        ...(n.occupancy ? { pmsStatus: n.occupancy.toUpperCase(), pmsStatusAt: n.sourceUpdatedAt || now } : {}),
      }, { transaction });
      action = "created";
      return;
    }

    const changes = { externalSyncedAt: now };
    let changed = false;
    const set = (k, v) => { if (v !== undefined && v !== room[k]) { changes[k] = v; changed = true; } };

    if (!room.externalId) { changes.externalId = n.externalId; action = "linked"; }
    if (matchedByExternalId && n.roomNumber !== room.roomNo) {
      const clash = await Room.findOne({ where: { roomNo: n.roomNumber, id: { [Op.ne]: room.id } }, transaction });
      if (clash) throw new Error(`room number ${n.roomNumber} is already used by another room`);
      set("roomNo", n.roomNumber);
    }
    set("type", n.type);
    set("floor", n.floor);
    if (n.description !== undefined) set("description", n.description);

    if (n.occupancy) {
      if (room.pmsStatus !== n.occupancy.toUpperCase()) {
        changes.pmsStatus = n.occupancy.toUpperCase();
        changes.pmsStatusAt = n.sourceUpdatedAt || now;
      }
      if (n.occupancy === "Occupied" && room.status !== RoomStatus.OCCUPIED) {
        if (OCCUPIABLE.includes(room.status)) { changes.status = RoomStatus.OCCUPIED; changed = true; }
        else if (room.status === RoomStatus.CLEANING) warning = `room ${room.roomNo} is being cleaned, so it was not marked occupied`;
      }
      if (n.occupancy === "Vacant" && room.status === RoomStatus.OCCUPIED) checkout = true; // applied by handleRoomVacated below
    }
    if (n.occupancyUnrecognized !== undefined) warning = `room ${room.roomNo}: occupancy value "${n.occupancyUnrecognized}" is not in occupiedValues/vacantValues`;

    roomNo = room.roomNo;
    await room.update(changes, { transaction });
    if (action !== "linked") action = changed ? "updated" : "unchanged";
  });

  if (checkout) {
    const when = n.sourceUpdatedAt && n.sourceUpdatedAt < now ? n.sourceUpdatedAt : now;
    await handleRoomVacated({
      eventType: "RoomVacated", eventId: `fdf-sync-${roomNo}-${now.getTime()}`, roomNo, occurredAt: when.toISOString(),
      source: "FrontDeskFlow room sync",
    });
  }
  return { action, checkedOut: checkout, warning };
};

const preflight = () => {
  const problems = [...mappingProblems()];
  if (!FRONTDESK_API.token) problems.unshift("FRONTDESK_API_TOKEN (the FrontDesk API key) is not set");
  if (!api.isConfigured()) problems.unshift("FRONTDESK_API_BASE_URL is not set");
  if (PMS.mode === "disabled") problems.unshift("the FrontDeskFlow integration is disabled (PMS_MODE=disabled)");
  return problems;
};

// Every sync run is stored as an integration event (shown on the Integrations page) and written to the system log.
const record = async (kind, startedAt, status, summary, lastError) => {
  const event = await IntegrationEvent.create({
    system: "PMS", direction: "IN", eventType: kind, eventId: `${kind.toLowerCase()}-${startedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    status, occurredAt: startedAt, payload: summary, lastError: lastError || null, processedAt: new Date(),
  });
  await logAction(null, status === S.PROCESSED ? "FRONTDESK_SYNC" : "FRONTDESK_SYNC_FAILED", "IntegrationEvent", event.id,
    lastError ? `${kind}: ${lastError}` : `${kind}: ${JSON.stringify(summary.counts || summary)}`);
  return event;
};

const failRun = async (kind, startedAt, message, status = 503) => {
  lastSync = { kind, at: startedAt, ok: false, error: message };
  await record(kind, startedAt, S.REJECTED, { error: message }, message).catch((e) => console.error("❌ Could not record sync failure:", e.message));
  return new AppError(`FrontDeskFlow sync failed: ${message}`, status);
};

// GET /housekeeping/rooms → create / update every room. One bad room never stops the others.
export const syncAllRooms = async ({ trigger = "manual" } = {}) => {
  if (running) throw new AppError("A FrontDeskFlow room sync is already running", 409);
  running = true;
  const startedAt = new Date();
  try {
    const problems = preflight();
    if (problems.length) throw await failRun("RoomSync", startedAt, problems.join("; "));

    let res;
    try { res = await api.fetchRooms(); } catch (err) { throw await failRun("RoomSync", startedAt, err.message, 502); }
    const list = getPath(res.data, ROOM_MAP.listPath);
    if (!Array.isArray(list)) {
      throw await failRun("RoomSync", startedAt, `GET ${FRONTDESK_API.paths.rooms} did not return a list at "${ROOM_MAP.listPath || "(response root)"}" — check FRONTDESK_ROOM_MAP.listPath`, 502);
    }

    const counts = { fetched: list.length, created: 0, linked: 0, updated: 0, unchanged: 0, checkouts: 0, errors: 0 };
    const errors = [];
    const warnings = [];
    const seen = new Set();
    for (const raw of list) {
      let label = "?";
      try {
        const n = normalizeRoom(raw);
        label = n.roomNumber;
        if (seen.has(n.roomNumber)) throw new Error("listed more than once in the same response — ignored");
        seen.add(n.roomNumber);
        const r = await applyRoom(n, startedAt);
        counts[r.action]++;
        if (r.checkedOut) counts.checkouts++;
        if (r.warning) warnings.push(r.warning);
      } catch (err) {
        counts.errors++;
        if (errors.length < MAX_LISTED_ERRORS) errors.push(`${label}: ${err.message}`);
      }
    }
    const summary = { trigger, counts, errors, warnings: warnings.slice(0, MAX_LISTED_ERRORS) };
    const lastError = errors.length ? `${counts.errors} room(s) failed: ${errors.slice(0, 3).join("; ")}` : null;
    await record("RoomSync", startedAt, S.PROCESSED, summary, lastError);
    lastSync = { kind: "RoomSync", at: startedAt, ok: !errors.length, counts, error: lastError };
    return summary;
  } finally {
    running = false;
  }
};

// GET /housekeeping/rooms/{roomNumber} → refresh one room.
export const syncOneRoom = async (roomNumber, { trigger = "manual" } = {}) => {
  if (!ROOM_NO.test(String(roomNumber || ""))) throw new AppError("A valid room number is required", 422);
  const startedAt = new Date();
  const problems = preflight();
  if (problems.length) throw await failRun("RoomSync", startedAt, problems.join("; "));

  let res;
  try { res = await api.fetchRoom(roomNumber); } catch (err) {
    throw await failRun("RoomSync", startedAt, err.message, err.status === 404 ? 404 : 502);
  }
  try {
    const raw = getPath(res.data, ROOM_MAP.roomPath);
    if (!raw || typeof raw !== "object") throw new Error(`no room object at "${ROOM_MAP.roomPath || "(response root)"}" — check FRONTDESK_ROOM_MAP.roomPath`);
    const n = normalizeRoom(raw);
    if (n.roomNumber !== String(roomNumber)) throw new Error(`FrontDeskFlow returned room ${n.roomNumber} when ${roomNumber} was requested`);
    const r = await applyRoom(n, startedAt);
    const summary = { trigger, roomNumber: n.roomNumber, ...r };
    await record("RoomSync", startedAt, S.PROCESSED, { trigger, counts: { fetched: 1, [r.action]: 1, checkouts: r.checkedOut ? 1 : 0, errors: 0 }, room: n.roomNumber, warnings: r.warning ? [r.warning] : [] });
    lastSync = { kind: "RoomSync", at: startedAt, ok: true, counts: { fetched: 1, [r.action]: 1 } };
    return summary;
  } catch (err) {
    throw await failRun("RoomSync", startedAt, err.message, 502);
  }
};

let timer = null;
// Optional background sync, started with the HTTP server when FRONTDESK_SYNC_INTERVAL_MINUTES > 0.
export const startFrontdeskSyncWorker = () => {
  const minutes = FRONTDESK_API.syncIntervalMinutes;
  if (timer || !minutes || PMS.mode === "disabled") return;
  const run = () => syncAllRooms({ trigger: "schedule" }).catch((err) => console.error("❌ FrontDeskFlow room sync:", err.message));
  timer = setInterval(run, minutes * 60000);
  timer.unref?.();
  setTimeout(run, 5000).unref?.();
  console.log(`🔌 FrontDeskFlow room sync every ${minutes} min`);
};
