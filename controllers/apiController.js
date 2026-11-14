import crypto from "crypto";
import { board, findByRoomNo, checkOut, checkIn } from "../services/roomService.js";
import { startTask, completeTask } from "../services/taskService.js";
import { reportIssue } from "../services/workOrderService.js";
import { listForUser, notifyUser } from "../services/notificationService.js";
import { TaskStatus } from "../models/enums.js";
import { wrap, toPlain, AppError } from "../utils/http.js";

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

const PMS_TOKEN = process.env.PMS_WEBHOOK_TOKEN || "roomcare-pms-dev-token";
const tokenMatches = (given) => {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PMS_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// POST /api/pms/events  header X-PMS-Token, body { event: "CHECK_OUT" | "CHECK_IN", roomNo }
// Webhook from the hotel's Property Management System.
export const pmsWebhook = wrap(async (req, res) => {
  if (!tokenMatches(req.get("X-PMS-Token"))) return res.status(401).json({ error: "Invalid PMS token" });
  const { event, roomNo } = req.body;
  const room = await findByRoomNo(roomNo);
  if (event === "CHECK_OUT") await checkOut(room, null, "PMS");
  else if (event === "CHECK_IN") await checkIn(room, null, "PMS");
  else throw new AppError('event must be "CHECK_OUT" or "CHECK_IN"');
  res.json({ ok: true, roomNo: room.roomNo, status: room.status });
});
