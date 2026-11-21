import * as fd from "../services/frontdeskService.js";
import * as sp from "../services/staffPayService.js";
import { AppError } from "../utils/http.js";
import { errorBody } from "../middleware/integrationAuth.js";

// Every /api/integrations response is { success: true, data, meta? } or { success: false, error: { code, message, details? } }.
const CODES = { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 422: "VALIDATION_ERROR" };

const handler = (fn) => async (req, res) => {
  try {
    const { status = 200, data, meta, extra } = await fn(req);
    res.status(status).json({ success: true, data, ...(meta ? { meta } : {}), ...(extra || {}) });
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json(errorBody(err.status, CODES[err.status] || "ERROR", err.message, err.details));
    if (err?.name === "SequelizeUniqueConstraintError") return res.status(409).json(errorBody(409, "CONFLICT", "Conflicts with an existing record"));
    console.error("❌ Integration API:", err);
    res.status(500).json(errorBody(500, "SERVER_ERROR", "Unexpected server error"));
  }
};
const key = (req) => req.get("Idempotency-Key");

// ── FrontDeskFlow → RoomCare ──
export const frontdeskCreateRoom = handler(async (req) => {
  const r = await fd.syncRoom(req.body, key(req));
  return { status: r.created ? 201 : 200, data: r.room, extra: { created: r.created, linked: r.linked, duplicate: Boolean(r.duplicate) } };
});
export const frontdeskUpdateRoom = handler(async (req) => {
  const r = await fd.updateSyncedRoom(req.params.externalRoomId, req.body, key(req));
  return { data: r.room, extra: { duplicate: r.duplicate, ...(r.ignored?.length ? { ignoredFields: r.ignored } : {}) } };
});
export const frontdeskCheckout = handler(async (req) => {
  const r = await fd.handleCheckout(req.body, key(req));
  return { status: r.taskCreated ? 201 : 200, data: r };
});
export const frontdeskGetRoom = handler(async (req) => ({ data: await fd.getSyncedRoom(req.params.externalRoomId) }));
export const frontdeskListRooms = handler(async (req) => { const r = await fd.listSyncedRooms(req.query); return { data: r.items, meta: r.meta }; });

// ── RoomCare → FrontDeskFlow ──
export const frontdeskStatusUpdates = handler(async (req) => { const r = await fd.roomStatusUpdates(req.query); return { data: r.items, meta: r.meta }; });
export const frontdeskCleanedRooms = handler(async (req) => { const r = await fd.cleanedRooms(req.query); return { data: r.items, meta: r.meta }; });

// ── StaffPay → RoomCare ──
export const staffpayEmployeeJobLogs = handler(async (req) => { const r = await sp.jobLogs(req.query, req.params.employeeId); return { data: r.items, meta: r.meta }; });
export const staffpayJobLogs = handler(async (req) => { const r = await sp.jobLogs(req.query); return { data: r.items, meta: r.meta }; });
export const staffpayWorkHours = handler(async (req) => { const r = await sp.workHours(req.query); return { data: r.items, meta: r.meta, extra: { summary: r.summary, disclaimer: r.disclaimer } }; });
export const staffpayOvertime = handler(async (req) => { const r = await sp.overtime(req.query); return { data: r.items, meta: r.meta, extra: { note: r.note } }; });
export const staffpayPerformance = handler(async (req) => { const r = await sp.performance(req.query); return { data: r.items, meta: r.meta, extra: { note: r.note } }; });
