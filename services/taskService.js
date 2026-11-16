import { Op } from "sequelize";
import { CleaningTask, Room, User } from "../models/index.js";
import { RoomStatus, TaskStatus, TASK_TYPES, PRIORITIES, ACTIVE_TASK_STATUSES } from "../models/enums.js";
import { AppError, startOfToday } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyUser, notifyRoles } from "./notificationService.js";
import { getRoom, setStatus } from "./roomService.js";

const label = (s) => s.replace(/_/g, " ").toLowerCase();
const STATUS_RANK = { IN_PROGRESS: 0, PENDING: 1, DONE: 2, INSPECTED: 3 };
const PRIORITY_RANK = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const byWorkOrder = (a, b) =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];

const taskIncludes = [
  { model: Room, as: "room" },
  { model: User, as: "housekeeper", attributes: ["id", "name", "staffCode"] },
  { model: User, as: "supervisor", attributes: ["id", "name"] },
];

// CT-<year>-<MMDD>-<nnn>, numbered per day from the highest code already used today.
const nextTaskCode = async () => {
  const now = new Date();
  const mmdd = String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  const prefix = `CT-${now.getFullYear()}-${mmdd}-`;
  const used = await CleaningTask.findAll({ where: { code: { [Op.like]: `${prefix}%` } }, attributes: ["code"], raw: true });
  const last = Math.max(0, ...used.map((t) => Number(t.code.slice(prefix.length)) || 0));
  return `${prefix}${String(last + 1).padStart(3, "0")}`;
};

export const getTask = async (id) => {
  const task = await CleaningTask.findByPk(id, { include: taskIncludes });
  if (!task) throw new AppError("Cleaning task not found", 404);
  return task;
};

export const listTasks = async ({ status, housekeeperId, roomId } = {}) => {
  const where = {};
  if (status) where.status = status;
  if (housekeeperId) where.housekeeperId = housekeeperId;
  if (roomId) where.roomId = roomId;
  return CleaningTask.findAll({ where, include: taskIncludes, order: [["createdAt", "DESC"]], limit: 200 });
};

// Housekeeper's list: everything still open plus what they finished today.
export const listForHousekeeper = async (housekeeperId) => {
  const tasks = await CleaningTask.findAll({
    where: {
      housekeeperId,
      [Op.or]: [{ status: ACTIVE_TASK_STATUSES }, { completedAt: { [Op.gte]: startOfToday() } }],
    },
    include: taskIncludes,
  });
  return tasks.sort(byWorkOrder);
};

// Vacant dirty rooms that nobody has been assigned to clean yet.
export const roomsNeedingTask = async () => {
  const rooms = await Room.findAll({
    where: { status: RoomStatus.VACANT_DIRTY },
    include: [{ model: CleaningTask, as: "tasks", required: false, where: { status: ACTIVE_TASK_STATUSES } }],
    order: [["floor", "ASC"], ["roomNo", "ASC"]],
  });
  return rooms.filter((r) => r.tasks.length === 0);
};

// 1.0 Assign Cleaning Tasks
export const assignTask = async ({ roomId, housekeeperId, taskType, priority, notes, dueAt }, admin) => {
  const room = await getRoom(roomId);
  const housekeeper = await User.findOne({ where: { id: housekeeperId || 0, role: "housekeeper", active: true } });
  if (!housekeeper) throw new AppError("Choose an active housekeeper.");
  if (!TASK_TYPES[taskType]) throw new AppError("Choose a valid task type.");
  if (!PRIORITIES.includes(priority)) throw new AppError("Choose a valid priority.");
  if (room.status === RoomStatus.OCCUPIED && taskType !== "STAYOVER") {
    throw new AppError(`Room ${room.roomNo} is occupied — only a stayover service can be assigned.`);
  }
  const open = await CleaningTask.findOne({ where: { roomId: room.id, status: ACTIVE_TASK_STATUSES } });
  if (open) throw new AppError(`Room ${room.roomNo} already has an open task (${open.code}).`);

  const task = await CleaningTask.create({
    code: await nextTaskCode(), roomId: room.id, housekeeperId: housekeeper.id, supervisorId: admin.id,
    taskType, title: TASK_TYPES[taskType], priority, notes: notes?.trim() || null, dueAt: dueAt || null,
    status: TaskStatus.PENDING,
  });
  await logAction(admin.id, "TASK_ASSIGN", "CleaningTask", task.id, `${task.code} Room ${room.roomNo} → ${housekeeper.name}`);
  await notifyUser(housekeeper, {
    channel: "PUSH",
    title: `New task: Room ${room.roomNo}`,
    message: `${task.title} (${priority}) assigned by ${admin.name}.${task.notes ? ` Note: ${task.notes}` : ""}`,
    link: "/tasks/my",
  });
  return task;
};

const getOwnTask = async (id, housekeeper) => {
  const task = await getTask(id);
  if (task.housekeeperId !== housekeeper.id) throw new AppError("This task is not assigned to you.", 403);
  return task;
};

// 2.0 Clean Room & Update Status — start
export const startTask = async (id, housekeeper) => {
  const task = await getOwnTask(id, housekeeper);
  if (task.status !== TaskStatus.PENDING) throw new AppError(`${task.code} cannot be started (it is ${label(task.status)}).`);
  task.status = TaskStatus.IN_PROGRESS;
  task.startedAt = new Date();
  await task.save();
  // Occupied (stayover) and out-of-order rooms keep their status while being cleaned.
  if ([RoomStatus.VACANT_DIRTY, RoomStatus.VACANT_CLEAN, RoomStatus.INSPECTED].includes(task.room.status)) {
    await setStatus(task.room, RoomStatus.CLEANING, housekeeper.id, `${task.code} started`);
  }
  await logAction(housekeeper.id, "TASK_START", "CleaningTask", task.id, task.code);
  return task;
};

// 2.0 Clean Room & Update Status — complete
export const completeTask = async (id, housekeeper, notes) => {
  const task = await getOwnTask(id, housekeeper);
  if (task.status !== TaskStatus.IN_PROGRESS) throw new AppError(`${task.code} must be started before it is completed.`);
  task.status = TaskStatus.DONE;
  task.completedAt = new Date();
  if (notes?.trim()) task.notes = [task.notes, `Housekeeper: ${notes.trim()}`].filter(Boolean).join("\n");
  await task.save();

  const room = task.room;
  if (room.status === RoomStatus.CLEANING) await setStatus(room, RoomStatus.VACANT_CLEAN, housekeeper.id, `${task.code} done`);
  await logAction(housekeeper.id, "TASK_DONE", "CleaningTask", task.id, task.code);
  if (room.status !== RoomStatus.OCCUPIED) {
    await notifyRoles("admin", {
      channel: "PUSH",
      title: `Room ${room.roomNo} cleaned`,
      message: `${housekeeper.name} completed ${task.code} (${task.title}). ${room.status === RoomStatus.OUT_OF_ORDER ? "Room is out of order until its repair is resolved." : "Ready for inspection."}`,
      link: `/inspections/new?roomId=${room.id}`,
    });
  }
  return task;
};
