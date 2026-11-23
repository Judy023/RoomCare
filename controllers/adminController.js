import { listUsers, createUser, updateUser } from "../services/userService.js";
import { listRooms, createRoom, updateRoom, deleteRoom } from "../services/roomService.js";
import { listLogs } from "../services/logService.js";
import { ROLES, ADMIN_ROOM_STATUSES, ROOM_TYPES } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";
import { integrationOverview, retryEvent } from "../services/pmsIntegrationService.js";
import { hrExportStats } from "../services/hrExportService.js";
import { integrationConfigSummary } from "../config/integrations.js";
import { connectionState } from "../services/roomIntegrationService.js";
import { syncAllRooms } from "../services/frontdeskSyncService.js";

export const usersPage = wrap(async (req, res) => {
  res.render("admin/users", { title: "Manage Users", users: toPlain(await listUsers()), roles: ROLES });
});

export const createUserAction = wrap(async (req, res) => {
  const user = await createUser(req.body, req.user.id);
  req.flash("success_msg", `Account created for ${user.name}.`);
  res.redirect("/admin/users");
});

export const updateUserAction = wrap(async (req, res) => {
  const user = await updateUser(req.params.id, req.body, req.user.id);
  req.flash("success_msg", `${user.name} updated.`);
  res.redirect("/admin/users");
});

export const roomsPage = wrap(async (req, res) => {
  // Occupied and out-of-order rooms are left out: their status is driven by check-in and work orders, not by the admin.
  const rooms = toPlain(await listRooms({}, { includeArchived: true })).filter((r) => ADMIN_ROOM_STATUSES.includes(r.status));
  const integration = await connectionState();
  res.render("admin/rooms", { title: integration.locked ? "Rooms" : "Manage Rooms", rooms, statuses: ADMIN_ROOM_STATUSES, types: ROOM_TYPES, integration, canSync: true });
});

// POST /admin/rooms/sync — pull every room from FrontDeskFlow now.
export const syncRoomsAction = wrap(async (req, res) => {
  const r = await syncAllRooms({ trigger: "manual" });
  const c = r.counts;
  req.flash("success_msg", `FrontDeskFlow sync finished: ${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged${c.errors ? `, ${c.errors} failed` : ""}.`);
  res.redirect(req.get("Referer") || "/rooms");
});

export const createRoomAction = wrap(async (req, res) => {
  const room = await createRoom(req.body, req.user.id);
  req.flash("success_msg", `Room ${room.roomNo} added.`);
  res.redirect("/admin/rooms");
});

export const updateRoomAction = wrap(async (req, res) => {
  const room = await updateRoom(req.params.id, req.body, req.user.id);
  req.flash("success_msg", `Room ${room.roomNo} updated.`);
  res.redirect("/admin/rooms");
});

export const deleteRoomAction = wrap(async (req, res) => {
  await deleteRoom(req.params.id, req.user.id);
  req.flash("success_msg", "Room deleted.");
  res.redirect("/admin/rooms");
});

export const logsPage = wrap(async (req, res) => {
  res.render("admin/logs", { title: "System Logs", logs: toPlain(await listLogs()) });
});

// PMS and HR/Payroll integration status: configuration (never the secrets), recent events, failed syncs.
export const integrationsPage = wrap(async (req, res) => {
  const [overview, hr] = await Promise.all([integrationOverview(), hrExportStats()]);
  res.render("admin/integrations", {
    title: "Integrations",
    integration: await connectionState(),
    canSync: true,
    config: integrationConfigSummary(),
    events: toPlain(overview.recent),
    failed: overview.failed,
    waiting: overview.waiting,
    hr: { ...hr, lastBatches: toPlain(hr.lastBatches) },
  });
});

export const retryIntegrationAction = wrap(async (req, res) => {
  const event = await retryEvent(req.params.id, req.user);
  if (event.status === "SENT") req.flash("success_msg", `${event.eventType} ${event.eventId} delivered.`);
  else req.flash("error_msg", `${event.eventType} ${event.eventId} still failing: ${event.lastError}`);
  res.redirect("/admin/integrations");
});
