import { Room, CleaningTask, WorkOrder, Inspection, User } from "../models/index.js";
import { RoomStatus, roomStatusLabel, ROOM_STATUSES, ADMIN_ROOM_STATUSES, ROOM_TYPES, ACTIVE_TASK_STATUSES, ACTIVE_WO_STATUSES, WorkOrderStatus } from "../models/enums.js";
import { AppError, toPlain } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyRoles } from "./notificationService.js";
import { queueCleaningStatus } from "./pmsIntegrationService.js";
import { connectionState, assertLocalRoomManagement, MANAGED_BY_FRONTDESK } from "./roomIntegrationService.js";

const label = roomStatusLabel;

export const getRoom = async (id) => {
  const room = await Room.findByPk(id);
  if (!room) throw new AppError("Room not found", 404);
  return room;
};

export const findByRoomNo = async (roomNo) => {
  const room = await Room.findOne({ where: { roomNo: String(roomNo).trim() } });
  if (!room) throw new AppError(`Room ${roomNo} not found`, 404);
  return room;
};

// Archived rooms (deleted in FrontDeskFlow) are kept for their history but are not offered for new work.
export const listRooms = (where = {}, { includeArchived = false } = {}) =>
  Room.findAll({ where: includeArchived ? where : { ...where, archivedAt: null }, order: [["floor", "ASC"], ["roomNo", "ASC"]] });

// Room status board: every room with its open task and outstanding work orders, grouped by floor.
export const board = async (statusFilter, { includeArchived = false } = {}) => {
  const active = includeArchived ? {} : { archivedAt: null };
  const rooms = toPlain(await Room.findAll({
    where: { ...active, ...(statusFilter && ROOM_STATUSES.includes(statusFilter) ? { status: statusFilter } : {}) },
    include: [
      {
        model: CleaningTask, as: "tasks", required: false,
        where: { status: ACTIVE_TASK_STATUSES },
        include: [{ model: User, as: "housekeeper", attributes: ["id", "name"] }],
      },
      {
        model: WorkOrder, as: "workOrders", required: false,
        where: { status: [...ACTIVE_WO_STATUSES, WorkOrderStatus.RESOLVED] },
        attributes: ["id", "code", "category", "status", "priority"],
      },
    ],
    order: [["floor", "ASC"], ["roomNo", "ASC"]],
  }));

  const all = await Room.findAll({ where: active, attributes: ["status"], raw: true });
  const counts = ROOM_STATUSES.map((status) => ({ status, count: all.filter((r) => r.status === status).length }));

  const floors = [];
  for (const room of rooms) {
    let floor = floors.find((f) => f.floor === room.floor);
    if (!floor) floors.push((floor = { floor: room.floor, rooms: [] }));
    floor.rooms.push(room);
  }
  return { floors, counts, total: all.length, shown: rooms.length };
};

export const roomDetail = async (id) => {
  const room = await Room.findByPk(id, {
    include: [
      { model: CleaningTask, as: "tasks", include: [{ model: User, as: "housekeeper", attributes: ["id", "name"] }] },
      { model: WorkOrder, as: "workOrders", include: [{ model: User, as: "assignedTo", attributes: ["id", "name"] }] },
      { model: Inspection, as: "inspections", include: [{ model: User, as: "admin", attributes: ["id", "name"] }] },
    ],
    order: [
      [{ model: CleaningTask, as: "tasks" }, "createdAt", "DESC"],
      [{ model: WorkOrder, as: "workOrders" }, "reportedAt", "DESC"],
      [{ model: Inspection, as: "inspections" }, "createdAt", "DESC"],
    ],
  });
  if (!room) throw new AppError("Room not found", 404);
  return room;
};

export const setStatus = async (room, status, userId, reason = "") => {
  if (room.status === status) return room;
  const from = room.status;
  room.status = status;
  await room.save();
  await logAction(userId, "ROOM_STATUS", "Room", room.id, `Room ${room.roomNo}: ${from} → ${status}${reason ? ` (${reason})` : ""}`);
  // Keep FrontDeskFlow informed of Dirty / In Progress. Not awaited: housekeeping never waits on, or fails because of, it.
  const notify = { [RoomStatus.VACANT_DIRTY]: "Dirty", [RoomStatus.CLEANING]: "In Progress" }[status];
  if (notify) queueCleaningStatus(room, notify);
  return room;
};

// Once FrontDesk is the room authority, guest occupancy (check-out / check-in) is recorded in FrontDesk only. Its
// check-out event is what makes a room Dirty and notifies the admins, so RoomCare never raises that notification itself.
// A local check-in is refused too: the next sync would see the room vacant in FrontDesk and report a false check-out.
export const OCCUPANCY_MANAGED_BY_FRONTDESK = "Guest check-out and check-in are recorded in FrontDesk. RoomCare marks the room Dirty and notifies admins when FrontDesk reports the check-out.";
const assertLocalOccupancy = async (source) => {
  if (source === "Admin" && (await connectionState()).locked) throw new AppError(OCCUPANCY_MANAGED_BY_FRONTDESK, 403);
};

// Admin / PMS check-out: OCCUPIED → VACANT_DIRTY, then admins are told to assign a cleaner.
export const checkOut = async (room, userId, source = "Admin") => {
  await assertLocalOccupancy(source);
  if (room.status !== RoomStatus.OCCUPIED) {
    throw new AppError(`Room ${room.roomNo} is not occupied (it is ${label(room.status)}).`);
  }
  await setStatus(room, RoomStatus.VACANT_DIRTY, userId, `check-out via ${source}`);
  await notifyRoles("admin", {
    channel: "PUSH",
    title: `Room ${room.roomNo} checked out`,
    message: `Room ${room.roomNo} (${room.type}) is dirty and needs a cleaning task.`,
    link: `/tasks?roomId=${room.id}`,
  });
  return room;
};

// Only rooms that passed inspection are sellable and can be given to the next guest.
export const checkIn = async (room, userId, source = "Admin") => {
  await assertLocalOccupancy(source);
  if (room.status !== RoomStatus.INSPECTED) {
    throw new AppError(`Room ${room.roomNo} is not ready — only vacant rooms can be assigned to a guest (it is ${label(room.status)}).`);
  }
  return setStatus(room, RoomStatus.OCCUPIED, userId, `check-in via ${source}`);
};

const validateRoom = ({ roomNo, type, floor }) => {
  if (!roomNo || !String(roomNo).trim()) throw new AppError("Room number is required.");
  if (!ROOM_TYPES.includes(type)) throw new AppError("Choose a valid room type.");
  if (!Number.isInteger(Number(floor)) || Number(floor) < 0) throw new AppError("Floor must be a whole number.");
};

export const createRoom = async (data, userId) => {
  await assertLocalRoomManagement();
  validateRoom(data);
  const room = await Room.create({
    roomNo: String(data.roomNo).trim(), type: data.type, floor: Number(data.floor),
    status: ADMIN_ROOM_STATUSES.includes(data.status) ? data.status : RoomStatus.VACANT_DIRTY, notes: data.notes || null,
  });
  await logAction(userId, "ROOM_CREATE", "Room", room.id, `Room ${room.roomNo} created`);
  return room;
};

// Fields that describe the room itself. Once FrontDeskFlow is the authority only housekeeping status may be changed here.
const RECORD_FIELDS = { roomNo: (r) => r.roomNo, type: (r) => r.type, floor: (r) => String(r.floor), notes: (r) => r.notes || "" };

export const updateRoom = async (id, data, userId) => {
  const room = await getRoom(id);
  if ((await connectionState()).locked) {
    const changed = Object.entries(RECORD_FIELDS).filter(([k, current]) => data[k] !== undefined && String(data[k]).trim() !== current(room));
    if (changed.length) throw new AppError(MANAGED_BY_FRONTDESK + ` (${changed.map(([k]) => k).join(", ")} cannot be changed here.)`, 403);
    if (data.status && ADMIN_ROOM_STATUSES.includes(data.status)) await setStatus(room, data.status, userId, "admin override");
    return room;
  }
  validateRoom({ roomNo: room.roomNo, ...data });
  room.type = data.type;
  room.floor = Number(data.floor);
  room.notes = data.notes || null;
  await room.save();
  if (data.status && ADMIN_ROOM_STATUSES.includes(data.status)) await setStatus(room, data.status, userId, "admin override");
  return room;
};

export const deleteRoom = async (id, userId) => {
  await assertLocalRoomManagement();
  const room = await getRoom(id);
  const history = (await CleaningTask.count({ where: { roomId: id } })) + (await WorkOrder.count({ where: { roomId: id } }));
  if (history) throw new AppError(`Room ${room.roomNo} has task or work order history and cannot be deleted.`);
  await Inspection.destroy({ where: { roomId: id } });
  await room.destroy();
  await logAction(userId, "ROOM_DELETE", "Room", Number(id), `Room ${room.roomNo} deleted`);
};
