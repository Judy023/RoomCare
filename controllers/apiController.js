import crypto from "crypto";
import { board, findByRoomNo, checkOut, checkIn } from "../services/roomService.js";
import { startTask, completeTask } from "../services/taskService.js";
import { reportIssue } from "../services/workOrderService.js";
import { listForUser, notifyUser } from "../services/notificationService.js";
import { TaskStatus } from "../models/enums.js";
import { wrap, toPlain, AppError } from "../utils/http.js";
import { PMS, HR } from "../config/integrations.js";
import { handleRoomVacated, handleRoomStatusUpdated } from "../services/pmsIntegrationService.js";
import { jobLogs, acknowledge, workSummary } from "../services/hrExportService.js";
import { logAction } from "../services/logService.js";

// GET /api/rooms — RoomService status board for the mobile app.
export const apiRooms = wrap(async (req, res) => {
  res.json(await board(req.query.status));
});

// PATCH /api/tasks/:id/status  { status: "IN_PROGRESS" | "DONE", notes? }
export const apiTaskStatus = wrap(async (req, res) => {
  const { status, notes } = req.body;
  if (status === TaskStatus.IN_PROGRESS) return res.json(toPlain(await startTask(req.params.id, req.user)));
  if (status === TaskStatus.DONE) return res.json(toPlain(await completeTask(req.params.id, req.user, notes)));
  throw new AppError('status must be "IN_PROGRESS" or "DONE"');
});

// POST /api/work-orders  (JSON or multipart with a "photo" field)
export const apiCreateWorkOrder = wrap(async (req, res) => {
  res.status(201).json(toPlain(await reportIssue(req.body, req.user, req.file)));
});

export const apiNotifications = wrap(async (req, res) => {
  res.json(toPlain(await listForUser(req.user.id, 50)));
});

// POST /api/notifications  { recipientId, channel, title, message, link? } — NotificationService entry point.
export const apiSendNotification = wrap(async (req, res) => {
  const { recipientId, channel = "IN_APP", title, message, link } = req.body;
  if (!recipientId || !title || !message) throw new AppError("recipientId, title and message are required");
  const n = await notifyUser(recipientId, { channel, title, message, link });
  if (!n) throw new AppError("Recipient not found", 404);
  res.status(201).json(toPlain(n));
});

// Constant-time comparison of a presented secret with the configured one. An unset secret never matches.
const tokenMatches = (given, expected) => {
  if (!expected) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const bearer = (req) => (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");

// POST /api/pms/events — webhook from the hotel's Property Management System. Header X-PMS-Token.
//   { eventType: "RoomVacated",       eventId, roomNo, occurredAt }          → creates the cleaning task
//   { eventType: "RoomStatusUpdated", eventId, roomNo, occurredAt, status }  → records PMS availability
//   { event: "CHECK_OUT" | "CHECK_IN", roomNo }                              → original events, unchanged
export const pmsWebhook = wrap(async (req, res) => {
  if (PMS.mode === "disabled") return res.status(503).json({ error: "PMS integration is disabled" });
  if (!tokenMatches(req.get("X-PMS-Token"), PMS.inboundToken)) return res.status(401).json({ error: "Invalid PMS token" });

  const { eventType, event, roomNo } = req.body || {};
  if (eventType === "RoomVacated") return res.json(await handleRoomVacated(req.body));
  if (eventType === "RoomStatusUpdated") return res.json(await handleRoomStatusUpdated(req.body));
  if (eventType) throw new AppError('eventType must be "RoomVacated" or "RoomStatusUpdated"');

  const room = await findByRoomNo(roomNo);
  if (event === "CHECK_OUT") await checkOut(room, null, "PMS");
  else if (event === "CHECK_IN") await checkIn(room, null, "PMS");
  else throw new AppError('event must be "CHECK_OUT" or "CHECK_IN"');
  res.json({ ok: true, roomNo: room.roomNo, status: room.status });
});

// HR/Payroll API — Authorization: Bearer <HR_API_TOKEN> (or X-HR-Token). Read-only except acknowledgements.
const requireHrToken = (req, res) => {
  if (!HR.apiToken) {
    res.status(503).json({ error: "HR/Payroll integration is not configured (HR_API_TOKEN)" });
    return false;
  }
  if (!tokenMatches(req.get("X-HR-Token") || bearer(req), HR.apiToken)) {
    res.status(401).json({ error: "Invalid HR token" });
    return false;
  }
  return true;
};

// GET /api/hr/job-logs?from=YYYY-MM-DD&to=YYYY-MM-DD&status=completed|all&pending=1&limit=&offset=
export const hrJobLogs = wrap(async (req, res) => {
  if (!requireHrToken(req, res)) return;
  const { from, to, status, pending, limit, offset } = req.query;
  const data = await jobLogs({ from, to, status, pending: pending === "1" || pending === "true", limit, offset });
  await logAction(null, "HR_EXPORT_PULL", "CleaningTask", null, `Job logs ${data.from}..${data.to} (${data.status}${data.pendingOnly ? ", pending" : ""}): ${data.records.length} of ${data.total}`);
  res.json(data);
});

// POST /api/hr/job-logs/ack  { batchId, recordIds: ["CT-…", …] }
export const hrAcknowledge = wrap(async (req, res) => {
  if (!requireHrToken(req, res)) return;
  res.json(await acknowledge(req.body || {}));
});

// GET /api/hr/work-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
export const hrWorkSummary = wrap(async (req, res) => {
  if (!requireHrToken(req, res)) return;
  const data = await workSummary(req.query);
  await logAction(null, "HR_EXPORT_PULL", "User", null, `Work summary ${data.from}..${data.to}: ${data.employees.length} housekeeper(s)`);
  res.json(data);
});
