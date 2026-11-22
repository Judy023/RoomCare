// Webhooks FrontDesk sends to RoomCare (ROOM_SYNC.pdf §5): POST /api/frontdesk/webhook
//
//   RoomVacated        a guest checked out (or moved rooms) → the room becomes Dirty and ONE cleaning task is created
//   RoomStatusChanged  the room's FrontDesk status changed  → that room is refreshed from FrontDesk (occupancy)
//   RoomCleaned        a cleaning was recorded             → origin HOUSEKEEPING is our own report echoed back;
//                                                            origin FRONT_DESK means the desk marked it clean without us,
//                                                            so the admins are told which RoomCare task to review
//
// Delivery is at-least-once: every event is recorded once by event_id and a repeat is acknowledged without being applied again.
// Each request is verified before anything else:
//   X-PMS-Signature = "sha256=" + hex(HMAC-SHA256(webhook secret, X-PMS-Timestamp + "." + raw body)), timestamp within ±300 s.
import crypto from "crypto";
import { UniqueConstraintError } from "sequelize";
import { IntegrationEvent, Room, CleaningTask } from "../models/index.js";
import { IntegrationStatus as S, ACTIVE_TASK_STATUSES } from "../models/enums.js";
import { PMS, FRONTDESK_API } from "../config/integrations.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyRoles } from "./notificationService.js";
import { signBody } from "./frontdeskApiClient.js";
import { handleRoomVacated, FRONTDESK_WEBHOOK_SOURCE } from "./pmsIntegrationService.js";
import { syncOneRoom } from "./frontdeskSyncService.js";
import { isConfigured } from "./frontdeskApiClient.js";

const MAX_SKEW_SECONDS = 300;

export const verifyWebhook = ({ raw, timestamp, signature }) => {
  if (PMS.mode === "disabled") throw new AppError("FrontDesk integration is disabled", 503);
  if (!FRONTDESK_API.webhookSecret) throw new AppError("FRONTDESK_WEBHOOK_SECRET is not set: webhooks cannot be verified, so none are accepted", 503);
  if (!raw || !timestamp || !signature) throw new AppError("Missing signature", 401);
  const expected = signBody(FRONTDESK_API.webhookSecret, timestamp, raw.toString("utf8"));
  const given = Buffer.from(String(signature));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new AppError("Invalid signature", 401);
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_SKEW_SECONDS)) throw new AppError("Signature expired", 401);
};

// Records an event once. Returns false when this event_id was already recorded (a repeat delivery).
const recordOnce = async (event, { status = S.PROCESSED, roomId = null, lastError = null } = {}) => {
  try {
    await IntegrationEvent.create({
      system: "PMS", direction: "IN", eventType: event.event, eventId: event.event_id, status,
      occurredAt: event.occurred_at ? new Date(event.occurred_at) : new Date(), payload: { ...event, source: FRONTDESK_WEBHOOK_SOURCE },
      roomId, processedAt: new Date(), lastError,
    });
    return true;
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    await IntegrationEvent.increment("duplicateCount", { where: { system: "PMS", direction: "IN", eventId: event.event_id } });
    return false;
  }
};

// Refreshes one room from FrontDesk; failures are logged but never fail the webhook (the periodic sync will catch up).
const refreshRoom = async (roomNumber) => {
  if (!roomNumber || !isConfigured()) return null;
  try { return await syncOneRoom(roomNumber, { trigger: "webhook" }); } catch (err) {
    console.error(`❌ Room ${roomNumber} refresh after webhook failed: ${err.message}`);
    return null;
  }
};

const roomVacated = async (event) => {
  // A room FrontDesk has but RoomCare does not yet is created first: nobody should add rooms by hand.
  if (!(await Room.findOne({ where: { roomNo: String(event.room_number) }, attributes: ["id"] }))) await refreshRoom(event.room_number);
  const result = await handleRoomVacated({
    eventType: "RoomVacated", eventId: event.event_id, roomNo: String(event.room_number), occurredAt: event.occurred_at,
    source: FRONTDESK_WEBHOOK_SOURCE, reason: event.reason, reservationCode: event.reservation_code, checkoutTime: event.checkout_time,
  });
  return { received: true, duplicate: Boolean(result.duplicate), task_id: result.task?.code ?? null };
};

const roomCleaned = async (event) => {
  const room = await Room.findOne({ where: { roomNo: String(event.room_number) }, attributes: ["id", "roomNo"] });
  const ok = await recordOnce(event, { roomId: room?.id ?? null });
  if (ok && event.origin === "FRONT_DESK" && room) {
    const open = await CleaningTask.findOne({ where: { roomId: room.id, status: ACTIVE_TASK_STATUSES }, order: [["id", "DESC"]] });
    await logAction(null, "FRONTDESK_MARKED_CLEAN", "Room", room.id, `Room ${room.roomNo} marked clean by the front desk (${event.event_id})${open ? `; ${open.code} still open` : ""}`);
    if (open) {
      await notifyRoles("admin", {
        channel: "PUSH",
        title: `Room ${room.roomNo} marked clean by the front desk`,
        message: `The front desk marked room ${room.roomNo} clean without RoomCare. ${open.code} is still open: please review or close it.`,
        link: `/tasks?roomId=${room.id}`,
      });
    }
  }
  return { received: true, duplicate: !ok };
};

// Handles one verified delivery. Throws AppError for a request RoomCare cannot accept (FrontDesk then retries on 5xx only
// if it is a server problem; unknown room etc. surface as 404 so they are visible in FrontDesk's console).
export const handleWebhook = async (raw) => {
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { throw new AppError("Body is not valid JSON", 400); }
  if (!event || typeof event !== "object" || !event.event || !event.event_id) throw new AppError("event and event_id are required", 422);

  switch (event.event) {
    case "RoomVacated": return roomVacated(event);
    case "RoomStatusChanged": {
      const fresh = await recordOnce(event);
      if (fresh) await refreshRoom(event.room_number);
      return { received: true, duplicate: !fresh };
    }
    case "RoomCleaned": return roomCleaned(event);
    default: // unknown or future event types are acknowledged, never rejected
      return { received: true, duplicate: !(await recordOnce(event)), ignored: true };
  }
};
