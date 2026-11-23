// Connection state and room-record authority for the FrontDeskFlow integration.
//
// FrontDeskFlow is the single source of truth for rooms. This module answers two questions, from facts stored in the
// database (never from a flag someone can flip by hand):
//
//   connectionState()           NOT_CONNECTED | CONNECTED | SYNC_ERROR
//   assertLocalRoomManagement() throws 403 when RoomCare may not add / edit / delete room records itself
//
// NOT_CONNECTED  nothing has ever been received from FrontDeskFlow (no room carries a FrontDeskFlow id and no clean
//                room sync has run). RoomCare keeps its own room management so development and testing still work.
// CONNECTED      FrontDeskFlow has delivered room data and the most recent room request / sync succeeded.
// SYNC_ERROR     the most recent room request or sync failed (or finished with failed rooms).
//
// Once FrontDeskFlow has delivered rooms (CONNECTED or SYNC_ERROR) RoomCare is locked out of room management, so an
// outage cannot be used to create rooms that would later collide with FrontDeskFlow's records.
import { Op } from "sequelize";
import { Room, IntegrationEvent } from "../models/index.js";
import { IntegrationStatus as S } from "../models/enums.js";
import { FRONTDESK_API, ROOM_AUTHORITY } from "../config/integrations.js";
import { AppError } from "../utils/http.js";

export const ConnectionState = { NOT_CONNECTED: "NOT_CONNECTED", CONNECTED: "CONNECTED", SYNC_ERROR: "SYNC_ERROR" };
export const CONNECTION_LABELS = { NOT_CONNECTED: "Not Connected", CONNECTED: "Connected", SYNC_ERROR: "Synchronization Error" };

// Event types written by the room sync (pull), the push API (POST / PUT / DELETE /rooms) and webhooks.
export const ROOM_EVENT_TYPES = ["RoomSync", "RoomSynced", "RoomUpdated", "RoomArchived"];
const base = { system: "PMS", direction: "IN", eventType: ROOM_EVENT_TYPES };

// "Configured" = somebody has actually set FrontDeskFlow credentials (the development fallback token does not count).
const isConfigured = () =>
  Boolean(process.env.FRONTDESK_API_KEY || process.env.PMS_WEBHOOK_TOKEN || (FRONTDESK_API.baseUrl && FRONTDESK_API.token));

export const connectionState = async () => {
  const [latest, lastClean, linkedRooms] = await Promise.all([
    IntegrationEvent.findOne({ where: base, order: [["id", "DESC"]] }),
    IntegrationEvent.findOne({ where: { ...base, status: S.PROCESSED, lastError: null }, order: [["id", "DESC"]] }),
    Room.count({ where: { externalId: { [Op.ne]: null } } }),
  ]);
  const everConnected = linkedRooms > 0 || Boolean(lastClean);
  const failed = Boolean(latest) && (latest.status !== S.PROCESSED || Boolean(latest.lastError));

  let state = ConnectionState.NOT_CONNECTED;
  if (everConnected) state = failed ? ConnectionState.SYNC_ERROR : ConnectionState.CONNECTED;
  else if (failed && isConfigured()) state = ConnectionState.SYNC_ERROR;

  const locked = ROOM_AUTHORITY === "frontdesk" || (ROOM_AUTHORITY === "auto" && everConnected);
  return {
    state,
    label: CONNECTION_LABELS[state],
    connected: state === ConnectionState.CONNECTED,
    notConnected: state === ConnectionState.NOT_CONNECTED,
    syncError: state === ConnectionState.SYNC_ERROR,
    locked,                       // true → FrontDeskFlow is the only authority for room records
    authorityMode: ROOM_AUTHORITY,
    configured: isConfigured(),
    linkedRooms,
    lastSuccessAt: lastClean?.processedAt || lastClean?.createdAt || null,
    lastError: failed ? (latest.lastError || "The last room request was rejected") : null,
    lastErrorAt: failed ? latest.createdAt : null,
  };
};

export const MANAGED_BY_FRONTDESK = "Room records are managed by FrontDeskFlow. Add, edit and delete rooms there; RoomCare receives them automatically.";

// Backend guard for every code path that creates, edits or deletes a room record on RoomCare's own authority.
export const assertLocalRoomManagement = async () => {
  if ((await connectionState()).locked) throw new AppError(MANAGED_BY_FRONTDESK, 403);
};

// Records a successful room request, so the connection state clears a past error and "last successful sync" is real.
export const recordRoomSuccess = async (eventType, context = {}) => {
  try {
    await IntegrationEvent.create({
      system: "PMS", direction: "IN", eventType, eventId: `ok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, status: S.PROCESSED,
      occurredAt: new Date(), processedAt: new Date(), payload: context,
    });
  } catch (e) {
    console.error("❌ Could not record room sync event:", e.message);
  }
};

// Records a failed room request so the connection state turns into SYNC_ERROR and the Integrations page shows why.
// Best effort: a failure to log must never mask the original error.
export const recordRoomFailure = async (eventType, err, context = {}) => {
  try {
    const message = err?.details ? `${err.message}: ${JSON.stringify(err.details).slice(0, 300)}` : String(err?.message || err);
    const id = `fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await IntegrationEvent.create({
      system: "PMS", direction: "IN", eventType, eventId: id, status: S.REJECTED,
      occurredAt: new Date(), processedAt: new Date(), payload: context, lastError: message.slice(0, 1000),
    });
  } catch (e) {
    console.error("❌ Could not record room sync failure:", e.message);
  }
};
