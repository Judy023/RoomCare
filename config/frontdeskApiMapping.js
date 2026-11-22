// Request/response mapping for the FrontDesk API, following "Connecting RoomCare to the FrontDesk" (ROOM_SYNC.pdf, 2026-11-21).
// The defaults below ARE that document's contract. Each can be overridden from .env (single-line JSON) if FrontDesk changes it.
//
//   Responses use the envelope { "success": true, "data": … }; GET /housekeeping/rooms returns the room array in `data`.
//   A room: { room_id, room_number, room_type, floor, status, status_changed_at, last_cleaned_at, open_task }.
import { FRONTDESK_API } from "./integrations.js";

const ROOM_NO = /^[A-Za-z0-9-]{1,20}$/;

const jsonEnv = (name) => {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return value;
    console.error(`❌ ${name} must be a JSON object — ignored.`);
  } catch (err) {
    console.error(`❌ ${name} is not valid JSON (${err.message}) — ignored.`);
  }
  return null;
};

// ── 1. Rooms: FrontDesk response → RoomCare room ─────────────────────────────────────────────────────
// Every value is a dotted path into the response JSON.
//   listPath / roomPath   where the room array / room object sits ("data" = inside the envelope)
//   roomNumber            REQUIRED, the room number
//   externalId            FrontDesk's permanent room id (`room_id`; the document says room_number "can change")
//   type, floor           needed to CREATE a room. `floor` is text in FrontDesk; it must be a whole number to be stored.
//   occupancy + occupiedValues / vacantValues / ignoredValues
//                         `status` values: OCCUPIED = Occupied; AVAILABLE, RESERVED, DIRTY, CLEANING = Vacant;
//                         MAINTENANCE = out of service, says nothing about guests (ignored, no warning).
//   updatedAt             `status_changed_at`, when the status last changed
export const ROOM_MAP = jsonEnv("FRONTDESK_ROOM_MAP") ?? {
  listPath: "data",
  roomPath: "data",
  roomNumber: "room_number",
  externalId: "room_id",
  type: "room_type",
  floor: "floor",
  occupancy: "status",
  occupiedValues: ["OCCUPIED"],
  vacantValues: ["AVAILABLE", "RESERVED", "DIRTY", "CLEANING"],
  ignoredValues: ["MAINTENANCE"],
  // Only used when a room is first CREATED in RoomCare: FrontDesk says it still needs cleaning, so it starts as Room Dirty
  // instead of Room Clean. Existing rooms' housekeeping status is never touched by a sync.
  dirtyValues: ["DIRTY", "CLEANING"],
  updatedAt: "status_changed_at",
};

// ── 2. Housekeeping status → POST /housekeeping/cleaning-status ──────────────────────────────────────
// FrontDesk accepts PENDING, IN_PROGRESS or COMPLETED. RoomCare's statuses map to them as follows (null = not sent):
//   Dirty → PENDING        a cleaning task exists for the vacated room
//   In Progress → IN_PROGRESS
//   Clean → COMPLETED      NOTE: FrontDesk makes the room AVAILABLE for guests on COMPLETED, and calls it "cleaned and inspected".
//                          To release rooms only after RoomCare's inspection, set Clean to null and Inspected to "COMPLETED"
//                          (and PMS_NOTIFY_ON=inspection_passed).
//   Inspected → (not sent) would duplicate COMPLETED
export const STATUS_WORDS = {
  Dirty: "PENDING",
  "In Progress": "IN_PROGRESS",
  Clean: "COMPLETED",
  Inspected: null,
  ...(jsonEnv("FRONTDESK_STATUS_WORDS") || {}),
};

// Request body per FrontDesk status (document §6.2). Placeholders:
//   {{roomNumber}} {{externalRoomId}} {{status}} {{housekeepingStatus}} {{occurredAt}} {{eventId}} {{relatedEventId}}
//   {{taskCode}} {{housekeeperName}} {{housekeeperStaffCode}} {{housekeeperEmployeeId}} {{startedAt}} {{completedAt}}
// A string that is exactly one placeholder keeps its type; one that resolves to nothing is left out of the body.
// A template without "byStatus" is used for every status.
export const CLEANING_STATUS_TEMPLATE = jsonEnv("FRONTDESK_CLEANING_STATUS_TEMPLATE") ?? {
  byStatus: {
    PENDING: {
      status: "{{status}}", external_task_id: "{{taskCode}}", room_number: "{{roomNumber}}",
      event_id: "{{relatedEventId}}", assigned_to: "{{housekeeperEmployeeId}}",
    },
    IN_PROGRESS: {
      status: "{{status}}", external_task_id: "{{taskCode}}", room_number: "{{roomNumber}}",
      event_id: "{{relatedEventId}}", started_by: "{{housekeeperEmployeeId}}", started_at: "{{startedAt}}",
    },
    COMPLETED: {
      status: "{{status}}", external_task_id: "{{taskCode}}", room_number: "{{roomNumber}}",
      event_id: "{{relatedEventId}}", completed_by: "{{housekeeperEmployeeId}}", completed_at: "{{completedAt}}",
    },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────
export const getPath = (obj, path) => {
  if (path === undefined || path === null || path === "") return obj;
  return String(path).split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
};

export const mappingProblems = (map = ROOM_MAP) => {
  const problems = [];
  if (!map) return ["FRONTDESK_ROOM_MAP is not set"];
  if (!map.roomNumber) problems.push("FRONTDESK_ROOM_MAP.roomNumber is required (the path to the room number in the response)");
  if (map.occupancy && (!Array.isArray(map.occupiedValues) || !Array.isArray(map.vacantValues) || !map.occupiedValues.length || !map.vacantValues.length)) {
    problems.push("FRONTDESK_ROOM_MAP.occupiedValues and vacantValues are required when occupancy is mapped");
  }
  return problems;
};

// What must be set before a status update can be sent.
export const statusRequestProblems = () => {
  const problems = [];
  if (!FRONTDESK_API.baseUrl) problems.push("FRONTDESK_API_BASE_URL is not set");
  if (!FRONTDESK_API.token) problems.push("FRONTDESK_API_TOKEN (the FrontDesk API key) is not set");
  if (!FRONTDESK_API.signingSecret) problems.push("FRONTDESK_API_SIGNING_SECRET is not set: FrontDesk refuses unsigned writes");
  return problems;
};

// Pulls one room out of FrontDesk's JSON into RoomCare's field names. Throws a readable Error when the record cannot be
// used. A field without a mapping stays undefined; nothing is invented.
export const normalizeRoom = (raw, map = ROOM_MAP) => {
  const roomNumber = getPath(raw, map.roomNumber);
  if (roomNumber === undefined || roomNumber === null || !ROOM_NO.test(String(roomNumber))) {
    throw new Error(`room has no valid room number at "${map.roomNumber}" (got ${JSON.stringify(roomNumber)})`);
  }
  const out = { roomNumber: String(roomNumber), externalId: String(roomNumber) };
  if (map.externalId) {
    const id = getPath(raw, map.externalId);
    if (id !== undefined && id !== null && String(id).length > 0 && String(id).length <= 100) out.externalId = String(id);
  }
  if (map.type) { const v = getPath(raw, map.type); if (v) out.type = String(v).trim().slice(0, 100); }
  if (!out.type && map.defaultType) out.type = String(map.defaultType);
  if (map.floor) {
    const v = getPath(raw, map.floor);
    const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 200) out.floor = n;
  }
  if (out.floor === undefined && map.defaultFloor !== undefined) out.floor = Number(map.defaultFloor);
  if (map.description) { const v = getPath(raw, map.description); if (typeof v === "string") out.description = v.trim().slice(0, 2000) || null; }
  if (map.updatedAt) { const d = new Date(getPath(raw, map.updatedAt)); if (!Number.isNaN(d.getTime())) out.sourceUpdatedAt = d; }
  if (map.occupancy) {
    const v = String(getPath(raw, map.occupancy) ?? "").trim().toLowerCase();
    const same = (list = []) => list.some((x) => String(x).trim().toLowerCase() === v);
    if (same(map.occupiedValues)) out.occupancy = "Occupied";
    else if (same(map.vacantValues)) out.occupancy = "Vacant";
    else if (!same(map.ignoredValues)) out.occupancyUnrecognized = v; // reported, never guessed
    out.needsCleaning = same(map.dirtyValues);
  }
  return out;
};

const clean = (s) => String(s).replace(/[^A-Za-z0-9._:-]/g, "-");

// Builds the POST /housekeeping/cleaning-status body for an outgoing event (payload shape: see pmsIntegrationService).
// Returns { skip: reason } when this status must not be sent, otherwise { body, status, key }. Throws when it cannot be built.
export const buildCleaningStatusRequest = (event) => {
  const p = event.payload || {};
  const hk = p.room?.housekeepingStatus;
  if (!Object.prototype.hasOwnProperty.call(STATUS_WORDS, hk)) throw new Error(`no FrontDesk status configured for "${hk}" (FRONTDESK_STATUS_WORDS)`);
  const word = STATUS_WORDS[hk];
  if (word === null) return { skip: `RoomCare status "${hk}" is not sent to FrontDesk (FRONTDESK_STATUS_WORDS)` };
  if (!p.task?.code) throw new Error(`FrontDesk needs a task id (external_task_id) but Room ${p.room?.roomNo} has no cleaning task yet`);

  const hkUser = p.task?.housekeeper;
  const values = {
    roomNumber: p.room?.roomNo, externalRoomId: p.room?.externalRoomId ?? null, status: word, housekeepingStatus: hk,
    occurredAt: p.occurredAt || (event.occurredAt && new Date(event.occurredAt).toISOString()), eventId: event.eventId,
    relatedEventId: p.relatedEventId ?? null,
    taskCode: p.task.code, housekeeperName: hkUser?.name ?? null, housekeeperStaffCode: hkUser?.staffCode ?? null,
    housekeeperEmployeeId: hkUser ? (hkUser.staffCode || `USER-${hkUser.id}`) : null,
    startedAt: p.task.startedAt ?? null, completedAt: p.task.completedAt ?? null,
  };
  const template = CLEANING_STATUS_TEMPLATE.byStatus ? CLEANING_STATUS_TEMPLATE.byStatus[word] : CLEANING_STATUS_TEMPLATE;
  if (!template) throw new Error(`FRONTDESK_CLEANING_STATUS_TEMPLATE has no body for status ${word}`);

  const need = (k) => { if (!(k in values)) throw new Error(`unknown placeholder {{${k}}} in FRONTDESK_CLEANING_STATUS_TEMPLATE`); return values[k]; };
  const fill = (node) => {
    if (typeof node === "string") {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole) return need(whole[1]);
      return node.replace(/\{\{(\w+)\}\}/g, (_, k) => String(need(k) ?? ""));
    }
    if (Array.isArray(node)) return node.map(fill);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const filled = fill(v);
        const wasWhole = typeof v === "string" && /^\{\{\w+\}\}$/.test(v);
        if (wasWhole && (filled === null || filled === undefined)) continue; // nothing to send for this field
        out[k] = filled;
      }
      return out;
    }
    return node;
  };
  // One Idempotency-Key per logical operation, identical on every retry of this event (8–100 chars, A-Za-z0-9._:-).
  const key = clean(`roomcare-${p.task.code}-${word}-${event.id ?? event.eventId}`).slice(0, 100);
  return { body: fill(template), status: word, key };
};

export const mappingSummary = () => ({
  roomMapProblems: mappingProblems(),
  statusRequestProblems: statusRequestProblems(),
  occupancyMapped: Boolean(ROOM_MAP?.occupancy),
});
