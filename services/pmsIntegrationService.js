// PMS integration layer.
//
//   PMS → RoomCare   RoomVacated        guest checked out: room becomes vacant dirty and an (unassigned)
//                                       checkout-clean task is created, once per event.
//                    RoomStatusUpdated  PMS reports its own availability (e.g. AVAILABLE) — stored on the room
//                                       for display only; it never changes RoomCare's housekeeping status.
//   RoomCare → PMS   CleaningCompleted  queued when a room's cleaning is finished (or its inspection passes,
//                                       see PMS_NOTIFY_ON) and delivered with retries.
//
// RoomCare never sets the PMS availability itself; it only reports that cleaning is done.
// In "mock" mode nothing is sent over the network — events are recorded and marked as mock deliveries.
import crypto from "crypto";
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, IntegrationEvent, Room, CleaningTask, SystemLog, User } from "../models/index.js";
import { RoomStatus, TaskStatus, ACTIVE_TASK_STATUSES, IntegrationStatus as S, TASK_TYPES } from "../models/enums.js";
import { PMS, FRONTDESK_API } from "../config/integrations.js";
import { mapOutgoingToFrontDesk } from "../config/frontdeskMapping.js";
import { buildCleaningStatusRequest, statusRequestProblems } from "../config/frontdeskApiMapping.js";
import { postCleaningStatus } from "./frontdeskApiClient.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyRoles } from "./notificationService.js";
import { nextTaskCode } from "./taskService.js";

// Marks RoomVacated events that arrived through FrontDesk's webhook (their event_id is a real FrontDesk event id).
export const FRONTDESK_WEBHOOK_SOURCE = "FrontDesk webhook";
const EVENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const ROOM_NO = /^[A-Za-z0-9-]{1,20}$/;
const PMS_STATUS = /^[A-Z_]{2,40}$/;
const label = (s) => String(s).replace(/_/g, " ").toLowerCase();

// ── Incoming ──────────────────────────────────────────────────────────────────────────────────────

const parseTimestamp = (value) => {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new AppError("occurredAt must be an ISO-8601 timestamp");
  if (d.getTime() > Date.now() + 5 * 60000) throw new AppError("occurredAt is in the future");
  return d;
};

const validateIncoming = (body) => {
  const { eventId, eventType, roomNo, occurredAt } = body || {};
  if (!EVENT_ID.test(String(eventId || ""))) throw new AppError("eventId is required (1–100 chars: letters, digits, . _ : -)");
  if (!ROOM_NO.test(String(roomNo || ""))) throw new AppError("roomNo is required");
  return { eventId: String(eventId), eventType, roomNo: String(roomNo), occurredAt: parseTimestamp(occurredAt) };
};

// Records the event once. A repeat of an already-processed event is reported as a duplicate;
// a repeat of a rejected (or stuck) event is processed again (the PMS may be retrying after fixing the cause).
const claimIncoming = async ({ eventId, eventType, occurredAt }, payload) => {
  try {
    return { event: await IntegrationEvent.create({ system: "PMS", direction: "IN", eventType, eventId, occurredAt, payload, status: S.PENDING }) };
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const event = await IntegrationEvent.findOne({ where: { system: "PMS", direction: "IN", eventId } });
    const stuck = event.status === S.PENDING && event.updatedAt < new Date(Date.now() - 2 * 60000); // crashed mid-way
    if (event.status === S.REJECTED || stuck) {
      await event.update({ status: S.PENDING, payload, occurredAt, lastError: null, attempts: event.attempts + 1 });
      return { event };
    }
    await event.increment("duplicateCount");
    await logAction(null, "PMS_EVENT_DUPLICATE", "IntegrationEvent", event.id, `${eventType} ${eventId} received again — ignored`);
    return { event, duplicate: true };
  }
};

const reject = async (event, err) => {
  await event.update({ status: S.REJECTED, lastError: err.message, processedAt: new Date() });
  await logAction(null, "PMS_EVENT_REJECTED", "IntegrationEvent", event.id, `${event.eventType} ${event.eventId}: ${err.message}`);
};

const result = async (event, extra = {}) => {
  const task = event.taskId ? await CleaningTask.findByPk(event.taskId, { attributes: ["code", "status", "housekeeperId"] }) : null;
  return { ok: true, eventId: event.eventId, status: event.status, ...extra, task: task ? { code: task.code, status: task.status } : null };
};

// Rooms in these states become vacant dirty when the guest leaves. A room already being cleaned or
// out of order keeps its status (the task still gets created/linked).
const VACATE_FROM = [RoomStatus.OCCUPIED, RoomStatus.VACANT_CLEAN, RoomStatus.INSPECTED];

export const handleRoomVacated = async (body) => {
  const input = validateIncoming(body);
  const { event, duplicate } = await claimIncoming(input, body);
  if (duplicate) return result(event, { duplicate: true });

  let created = null;
  let room;
  let becameDirty = false;
  try {
    await sequelize.transaction(async (transaction) => {
      room = await Room.findOne({ where: { roomNo: input.roomNo }, lock: transaction.LOCK.UPDATE, transaction });
      if (!room) throw new AppError(`Room ${input.roomNo} not found`, 404);

      if (VACATE_FROM.includes(room.status)) {
        const from = room.status;
        becameDirty = true;
        await room.update({ status: RoomStatus.VACANT_DIRTY }, { transaction });
        await SystemLog.create({ userId: null, action: "ROOM_STATUS", entity: "Room", entityId: room.id,
          details: `Room ${room.roomNo}: ${from} → ${RoomStatus.VACANT_DIRTY} (PMS RoomVacated ${input.eventId})` }, { transaction });
      }

      // One open task per room: reuse it if housekeeping already has one.
      let task = await CleaningTask.findOne({ where: { roomId: room.id, status: ACTIVE_TASK_STATUSES }, transaction });
      if (!task) {
        task = await CleaningTask.create({
          code: await nextTaskCode(), roomId: room.id, housekeeperId: null, adminId: null,
          taskType: "CHECKOUT_CLEAN", title: TASK_TYPES.CHECKOUT_CLEAN, priority: "MEDIUM", status: TaskStatus.PENDING,
          source: "PMS", notes: `Guest check-out reported by PMS at ${input.occurredAt.toISOString()} (event ${input.eventId}).`,
        }, { transaction });
        created = task;
        await SystemLog.create({ userId: null, action: "TASK_AUTO_CREATE", entity: "CleaningTask", entityId: task.id,
          details: `${task.code} Room ${room.roomNo} created from PMS RoomVacated ${input.eventId}` }, { transaction });
      }
      await event.update({ status: S.PROCESSED, roomId: room.id, taskId: task.id, processedAt: new Date(), lastError: null }, { transaction });
    });
  } catch (err) {
    await reject(event, err);
    throw err instanceof AppError ? err : new AppError("Event could not be processed", 500);
  }

  // Tell FrontDeskFlow the room is now Dirty (not awaited: delivery problems never fail the check-out).
  if (becameDirty || created) queueCleaningStatus(room, "Dirty");

  if (created) {
    await notifyRoles("admin", {
      channel: "PUSH",
      title: `Room ${room.roomNo} is dirty (FrontDesk check-out)`,
      message: `FrontDesk reported the guest check-out. Room ${room.roomNo} needs cleaning: ${created.code} was created and is waiting for a housekeeper.`,
      link: `/tasks?roomId=${room.id}`,
    });
  }
  return result(event, { taskCreated: Boolean(created), roomStatus: room.status });
};

export const handleRoomStatusUpdated = async (body) => {
  const input = validateIncoming(body);
  const status = String(body.status || "").toUpperCase();
  if (!PMS_STATUS.test(status)) throw new AppError("status is required (e.g. AVAILABLE)");
  const { event, duplicate } = await claimIncoming(input, body);
  if (duplicate) return result(event, { duplicate: true });

  try {
    const room = await Room.findOne({ where: { roomNo: input.roomNo } });
    if (!room) throw new AppError(`Room ${input.roomNo} not found`, 404);
    // Ignore stale updates that arrive after a newer one.
    if (!room.pmsStatusAt || room.pmsStatusAt <= input.occurredAt) {
      await room.update({ pmsStatus: status, pmsStatusAt: input.occurredAt });
    }
    await event.update({ status: S.PROCESSED, roomId: room.id, processedAt: new Date() });
    await logAction(null, "PMS_STATUS_SYNC", "Room", room.id, `Room ${room.roomNo}: PMS reports ${status} (${input.eventId})`);
    return result(event, { roomNo: room.roomNo, pmsStatus: room.pmsStatus });
  } catch (err) {
    await reject(event, err);
    throw err instanceof AppError ? err : new AppError("Event could not be processed", 500);
  }
};

// ── Outgoing ──────────────────────────────────────────────────────────────────────────────────────

const backoffMinutes = (attempts) => Math.min(60, 2 ** Math.max(0, attempts - 1)); // 1, 2, 4, 8, 16, 32, 60 …

const buildCleaningCompleted = async (task, verification) => {
  const room = await Room.findByPk(task.roomId);
  const housekeeper = task.housekeeperId ? await User.findByPk(task.housekeeperId, { attributes: ["id", "name", "staffCode"] }) : null;
  const relatedEventId = await relatedFrontDeskEventId(task.id);
  const completedAt = task.completedAt || new Date();
  return {
    eventId: `roomcare-cc-${task.id}-${new Date(verification === "PASSED" ? task.inspectedAt || Date.now() : completedAt).getTime()}`,
    eventType: "CleaningCompleted",
    occurredAt: new Date().toISOString(),
    source: "RoomCare",
    // Housekeeping state only. RoomCare does not decide occupancy: the front desk confirms no guest is assigned.
    room: {
      roomNo: room.roomNo, roomCareId: room.id, externalRoomId: room.externalId || null,
      housekeepingStatus: room.status === RoomStatus.INSPECTED ? "Inspected" : "Clean",
    },
    task: {
      code: task.code,
      type: task.taskType,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      completedAt: new Date(completedAt).toISOString(),
      housekeeper: housekeeper ? { id: housekeeper.id, staffCode: housekeeper.staffCode, name: housekeeper.name } : null,
    },
    verification, // PENDING = inspection still to come, PASSED = inspection passed
    relatedEventId,
  };
};

// Queues CleaningCompleted for a task and tries to deliver it right away. Never throws: a failed
// delivery must not undo the housekeeper's work — it is retried and shown on the Integrations page.
export const queueCleaningCompleted = async (task, verification = "PENDING") => {
  if (PMS.mode === "disabled") return null;
  try {
    const payload = await buildCleaningCompleted(task, verification);
    let event;
    try {
      event = await IntegrationEvent.create({
        system: "PMS", direction: "OUT", eventType: "CleaningCompleted", eventId: payload.eventId,
        occurredAt: new Date(payload.occurredAt), payload, status: S.PENDING, nextAttemptAt: new Date(),
        roomId: task.roomId, taskId: task.id,
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) return null; // already queued for this completion
      throw err;
    }
    await logAction(null, "PMS_EVENT_QUEUED", "IntegrationEvent", event.id, `CleaningCompleted ${task.code} (${verification.toLowerCase()})`);
    return await deliver(event.id);
  } catch (err) {
    console.error("❌ Could not queue CleaningCompleted:", err.message);
    return null;
  }
};

// The FrontDesk RoomVacated event a task answers (its event_id), so FrontDesk can link the task to the right stay.
// Only events that really came from FrontDesk's webhook qualify; ids from other sources are not FrontDesk event ids.
const relatedFrontDeskEventId = async (taskId) => {
  const vacated = await IntegrationEvent.findOne({
    where: { system: "PMS", direction: "IN", eventType: "RoomVacated", taskId, status: S.PROCESSED },
    order: [["createdAt", "DESC"]],
  });
  return vacated?.payload?.source === FRONTDESK_WEBHOOK_SOURCE ? vacated.eventId : null;
};

// Queues a housekeeping status change for FrontDesk (Dirty → PENDING, In Progress → IN_PROGRESS) and tries to deliver it
// right away. "Clean" and "Inspected" go out through queueCleaningCompleted, which carries the inspection details.
// FrontDesk identifies the work by task id (external_task_id), so nothing is queued while the room has no cleaning task;
// the Dirty/PENDING announcement is made when the task exists, once per task.
// Never throws: a failed delivery must not undo the work — it is retried and shown on the Integrations page.
export const queueCleaningStatus = async (room, housekeepingStatus) => {
  if (PMS.mode === "disabled") return null;
  try {
    const task = await CleaningTask.findOne({ where: { roomId: room.id, status: ACTIVE_TASK_STATUSES }, order: [["id", "DESC"]] });
    if (!task) return null;
    const slug = housekeepingStatus.replace(/\W+/g, "").toLowerCase();
    if (housekeepingStatus === "Dirty") {
      const already = await IntegrationEvent.count({
        where: { system: "PMS", direction: "OUT", eventType: "CleaningStatusChanged", taskId: task.id, eventId: { [Op.like]: `roomcare-cs-${task.id}-dirty-%` } },
      });
      if (already) return null;
    }
    const now = new Date();
    const housekeeper = task.housekeeperId ? await User.findByPk(task.housekeeperId, { attributes: ["id", "name", "staffCode"] }) : null;
    const payload = {
      eventId: `roomcare-cs-${task.id}-${slug}-${now.getTime()}`,
      eventType: "CleaningStatusChanged",
      occurredAt: now.toISOString(),
      source: "RoomCare",
      room: { roomNo: room.roomNo, roomCareId: room.id, externalRoomId: room.externalId || null, housekeepingStatus },
      task: {
        code: task.code, type: task.taskType,
        startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null, completedAt: null,
        housekeeper: housekeeper ? { id: housekeeper.id, staffCode: housekeeper.staffCode, name: housekeeper.name } : null,
      },
      verification: null,
      relatedEventId: await relatedFrontDeskEventId(task.id),
    };
    let event;
    try {
      event = await IntegrationEvent.create({
        system: "PMS", direction: "OUT", eventType: "CleaningStatusChanged", eventId: payload.eventId,
        occurredAt: now, payload, status: S.PENDING, nextAttemptAt: now, roomId: room.id, taskId: task.id,
      });
    } catch (err) {
      if (err instanceof UniqueConstraintError) return null;
      throw err;
    }
    await logAction(null, "PMS_EVENT_QUEUED", "IntegrationEvent", event.id, `CleaningStatusChanged ${task.code} Room ${room.roomNo} → ${housekeepingStatus}`);
    return await deliver(event.id);
  } catch (err) {
    console.error("❌ Could not queue CleaningStatusChanged:", err.message);
    return null;
  }
};

// Something retrying cannot fix (the request itself is wrong or not configured).
const permanent = (err) => Object.assign(err, { retryable: false });

const send = async (event) => {
  if (PMS.mode === "mock") {
    if (PMS.mockFail) throw new Error("Mock PMS failure (PMS_MOCK_FAIL=1)");
    let preview = "";
    try {
      const req = buildCleaningStatusRequest(event);
      preview = req.skip ? ` (would skip: ${req.skip})` : ` (would POST ${FRONTDESK_API.paths.cleaningStatus} ${JSON.stringify(req.body)})`;
    } catch (err) { preview = ` (request problem: ${err.message})`; }
    return `MOCK: recorded only, not sent to a real PMS${preview}`.slice(0, 1000);
  }
  // FrontDesk's real API (POST /housekeeping/cleaning-status), when its base URL is configured.
  if (FRONTDESK_API.baseUrl) {
    const problems = statusRequestProblems();
    if (problems.length) throw permanent(new Error(problems.join("; ")));
    let req;
    try { req = buildCleaningStatusRequest(event); } catch (err) { throw permanent(err); }
    if (req.skip) return `SKIPPED: ${req.skip}`;
    try {
      const res = await postCleaningStatus(req.body, req.key);
      return `HTTP ${res.status}${res.replayed ? " (replayed)" : ""}${res.text ? ` ${res.text.slice(0, 1000)}` : ""}`;
    } catch (err) {
      if (err.alreadyDone) return `ALREADY RECORDED (${err.code}): treated as delivered`; // document §9.2: "treat as done"
      throw err;
    }
  }
  // Legacy single-URL push (before FrontDesk's endpoints were known).
  if (!PMS.outboundUrl) throw permanent(new Error("FRONTDESK_API_BASE_URL (or the legacy PMS_OUTBOUND_URL) is not configured"));
  const body = JSON.stringify(mapOutgoingToFrontDesk(event));
  const headers = { "Content-Type": "application/json", "X-RoomCare-Event-Id": event.eventId, "Idempotency-Key": event.eventId };
  if (PMS.outboundToken) headers[PMS.outboundAuthHeader] = `${PMS.outboundAuthScheme ? PMS.outboundAuthScheme + " " : ""}${PMS.outboundToken}`;
  if (PMS.signingSecret) headers["X-RoomCare-Signature"] = "sha256=" + crypto.createHmac("sha256", PMS.signingSecret).update(body).digest("hex");
  const res = await fetch(PMS.outboundUrl, { method: PMS.outboundMethod, headers, body, signal: AbortSignal.timeout(PMS.timeoutMs) });
  const text = (await res.text()).slice(0, 1000);
  if (!res.ok) throw new Error(`PMS answered HTTP ${res.status}${text ? `: ${text}` : ""}`);
  return `HTTP ${res.status}${text ? ` ${text}` : ""}`;
};

// Delivers one queued event. The status flip PENDING → SENDING is atomic, so an event is never sent twice
// at the same time (worker and a manual retry, or two app instances).
export const deliver = async (id) => {
  const [claimed] = await IntegrationEvent.update(
    { status: S.SENDING },
    { where: { id, direction: "OUT", status: S.PENDING } }
  );
  if (!claimed) return IntegrationEvent.findByPk(id);
  const event = await IntegrationEvent.findByPk(id);
  const attempts = event.attempts + 1;
  try {
    const response = await send(event);
    await event.update({ status: S.SENT, attempts, response, lastError: null, nextAttemptAt: null, processedAt: new Date() });
    await logAction(null, "PMS_EVENT_SENT", "IntegrationEvent", event.id, `${event.eventType} ${event.eventId}${PMS.mode === "mock" ? " (mock)" : ""}`);
  } catch (err) {
    // A request FrontDesk rejects as wrong (any 4xx except the retryable ones) is never retried unchanged.
    const giveUp = attempts >= PMS.maxAttempts || err.retryable === false;
    await event.update({
      status: giveUp ? S.FAILED : S.PENDING, attempts, lastError: err.message,
      nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMinutes(attempts) * 60000),
    });
    await logAction(null, giveUp ? "PMS_EVENT_FAILED" : "PMS_EVENT_RETRY", "IntegrationEvent", event.id,
      `${event.eventType} ${event.eventId} attempt ${attempts}/${PMS.maxAttempts}: ${err.message}`);
    if (giveUp) {
      await notifyRoles("admin", {
        channel: "PUSH",
        title: "PMS sync failed",
        message: `${event.eventType} for ${event.payload?.task?.code || event.eventId} could not be delivered after ${attempts} attempts: ${err.message}`,
        link: "/admin/integrations",
      });
    }
  }
  return event;
};

// Retries every due event (called by the background worker).
export const retryDue = async () => {
  // A SENDING row older than 5 minutes means the process stopped mid-delivery: make it retryable.
  await IntegrationEvent.update(
    { status: S.PENDING, nextAttemptAt: new Date() },
    { where: { direction: "OUT", status: S.SENDING, updatedAt: { [Op.lt]: new Date(Date.now() - 5 * 60000) } } }
  );
  const due = await IntegrationEvent.findAll({
    where: { system: "PMS", direction: "OUT", status: S.PENDING, nextAttemptAt: { [Op.lte]: new Date() } },
    order: [["nextAttemptAt", "ASC"]],
    limit: 25,
  });
  for (const event of due) await deliver(event.id);
  return due.length;
};

// Manual retry from the Integrations page (failed or still-waiting events only).
export const retryEvent = async (id, admin) => {
  const event = await IntegrationEvent.findOne({ where: { id, direction: "OUT" } });
  if (!event) throw new AppError("Integration event not found", 404);
  if (![S.FAILED, S.PENDING].includes(event.status)) throw new AppError(`This event is ${label(event.status)} and cannot be retried.`);
  await event.update({ status: S.PENDING, nextAttemptAt: new Date(), attempts: event.status === S.FAILED ? PMS.maxAttempts - 1 : event.attempts });
  await logAction(admin.id, "PMS_EVENT_MANUAL_RETRY", "IntegrationEvent", event.id, `${event.eventType} ${event.eventId}`);
  return deliver(event.id);
};

let timer = null;
// Background retry loop, started with the HTTP server.
export const startIntegrationWorker = (intervalMs = 60000) => {
  if (timer || PMS.mode === "disabled") return;
  timer = setInterval(() => retryDue().catch((err) => console.error("❌ PMS retry worker:", err.message)), intervalMs);
  timer.unref?.();
  if (PMS.usingDevToken) console.warn("⚠️  PMS_WEBHOOK_TOKEN is not set — using the development token. Set it before going live.");
  console.log(`🔌 PMS integration: ${PMS.mode} mode${PMS.mode === "mock" ? " (no real PMS connection)" : ""}`);
};

// ── Admin screen data ─────────────────────────────────────────────────────────────────────────────

export const integrationOverview = async () => {
  const [recent, failed, waiting, counts] = await Promise.all([
    IntegrationEvent.findAll({ include: [{ model: Room, as: "room", attributes: ["id", "roomNo"] }, { model: CleaningTask, as: "task", attributes: ["id", "code"] }], order: [["createdAt", "DESC"]], limit: 100 }),
    IntegrationEvent.count({ where: { direction: "OUT", status: S.FAILED } }),
    IntegrationEvent.count({ where: { direction: "OUT", status: [S.PENDING, S.SENDING] } }),
    IntegrationEvent.findAll({ attributes: ["system", "direction", "status", [sequelize.fn("COUNT", sequelize.col("id")), "n"]], group: ["system", "direction", "status"], raw: true }),
  ]);
  return { recent, failed, waiting, counts };
};

export const failedSyncCount = () => IntegrationEvent.count({ where: { direction: "OUT", status: S.FAILED } });
