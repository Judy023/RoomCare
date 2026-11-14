import { sequelize, WorkOrder, Room, User, CleaningTask, PartUsage, InventoryItem } from "../models/index.js";
import { RoomStatus, WorkOrderStatus as S, WO_CATEGORIES, PRIORITIES, SLA_HOURS, ACTIVE_WO_STATUSES } from "../models/enums.js";
import { AppError, toPlain } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyUser, notifyRoles } from "./notificationService.js";
import { getRoom, setStatus } from "./roomService.js";
import { checkLowStock } from "./inventoryService.js";

const label = (s) => s.replace(/_/g, " ").toLowerCase();

const woIncludes = [
  { model: Room, as: "room" },
  { model: User, as: "reportedBy", attributes: ["id", "name", "role"] },
  { model: User, as: "assignedTo", attributes: ["id", "name", "phone", "specialty"] },
];

// Response-time target per priority; the clock runs from reportedAt until resolvedAt (or now).
export const computeSLA = (wo) => {
  const hours = SLA_HOURS[wo.priority] ?? 24;
  const dueAt = new Date(new Date(wo.reportedAt).getTime() + hours * 3600e3);
  const end = wo.resolvedAt ? new Date(wo.resolvedAt) : new Date();
  const overdue = ![S.CANCELLED].includes(wo.status) && end > dueAt;
  return { hours, dueAt, overdue };
};

export const withSla = (wo) => {
  const plain = toPlain(wo);
  return { ...plain, sla: computeSLA(plain) };
};

export const getWorkOrder = async (id) => {
  const wo = await WorkOrder.findByPk(id, {
    include: [
      ...woIncludes,
      { model: CleaningTask, as: "task", attributes: ["id", "code", "title"] },
      {
        model: PartUsage, as: "parts",
        include: [{ model: InventoryItem, as: "item" }, { model: User, as: "technician", attributes: ["id", "name"] }],
      },
    ],
    order: [[{ model: PartUsage, as: "parts" }, "createdAt", "ASC"]],
  });
  if (!wo) throw new AppError("Work order not found", 404);
  return wo;
};

export const listWorkOrders = async ({ status, priority, category, assignedToId, roomId, activeOnly } = {}) => {
  const where = {};
  if (status) where.status = status;
  else if (activeOnly) where.status = [...ACTIVE_WO_STATUSES, S.RESOLVED];
  if (priority) where.priority = priority;
  if (category) where.category = category;
  if (assignedToId) where.assignedToId = assignedToId;
  if (roomId) where.roomId = roomId;
  const rows = await WorkOrder.findAll({ where, include: woIncludes, order: [["reportedAt", "DESC"]], limit: 300 });
  return rows.map(withSla);
};

// 3.0 Report Maintenance Issue
export const reportIssue = async ({ roomId, category, description, priority = "MEDIUM", taskId }, user, photo) => {
  const room = await getRoom(roomId);
  if (!WO_CATEGORIES.includes(category)) throw new AppError("Choose a valid issue category.");
  if (!PRIORITIES.includes(priority)) throw new AppError("Choose a valid priority.");
  if (!description || description.trim().length < 5) throw new AppError("Describe the issue (at least 5 characters).");

  let linkedTaskId = null;
  if (taskId) {
    const task = await CleaningTask.findByPk(taskId);
    if (task && task.roomId === room.id) linkedTaskId = task.id;
  }

  const wo = await WorkOrder.create({
    roomId: room.id, category, description: description.trim(), priority, status: S.OPEN,
    photoUrl: photo ? `/uploads/${photo.filename}` : null, reportedById: user.id, taskId: linkedTaskId, reportedAt: new Date(),
  });
  wo.code = `WO-${1000 + wo.id}`;
  await wo.save();

  // A guest is still in an occupied room, so it stays occupied and is flagged by the open work order.
  if (room.status !== RoomStatus.OCCUPIED) await setStatus(room, RoomStatus.OUT_OF_ORDER, user.id, `${wo.code} reported`);
  await logAction(user.id, "WO_REPORT", "WorkOrder", wo.id, `${wo.code} Room ${room.roomNo}: ${category} — ${wo.description}`);
  await notifyRoles("supervisor", {
    channel: "PUSH",
    title: `New issue in Room ${room.roomNo}`,
    message: `${wo.code} ${category} (${priority}): "${wo.description}" — reported by ${user.name}.`,
    link: `/work-orders/${wo.id}`,
  });
  return wo;
};

// 4.0 Assign Work Order (supervisor sets priority and picks a technician)
export const assignWorkOrder = async (id, { technicianId, priority }, supervisor) => {
  const wo = await getWorkOrder(id);
  if (![S.OPEN, S.ASSIGNED].includes(wo.status)) throw new AppError(`Only open or assigned work orders can be (re)assigned — ${wo.code} is ${label(wo.status)}.`);
  const tech = await User.findOne({ where: { id: technicianId || 0, role: "technician", active: true } });
  if (!tech) throw new AppError("Choose an active technician.");
  if (priority) {
    if (!PRIORITIES.includes(priority)) throw new AppError("Choose a valid priority.");
    wo.priority = priority;
  }
  wo.assignedToId = tech.id;
  wo.status = S.ASSIGNED;
  wo.assignedAt = new Date();
  await wo.save();
  await logAction(supervisor.id, "WO_ASSIGN", "WorkOrder", wo.id, `${wo.code} → ${tech.name} (${wo.priority})`);
  await notifyUser(tech, {
    channel: "SMS",
    title: `${wo.code} assigned to you`,
    message: `RoomCare: ${wo.code} Room ${wo.room.roomNo} – ${wo.category}: "${wo.description}" (${wo.priority}). Please accept in the app.`,
    link: `/work-orders/${wo.id}`,
  });
  return wo;
};

const getTechWorkOrder = async (id, tech) => {
  const wo = await getWorkOrder(id);
  if (wo.assignedToId !== tech.id) throw new AppError("This work order is not assigned to you.", 403);
  return wo;
};

const transition = async (wo, from, to, userId, action, extra = {}) => {
  if (![].concat(from).includes(wo.status)) throw new AppError(`${wo.code} is ${label(wo.status)} and cannot move to ${label(to)}.`);
  Object.assign(wo, extra, { status: to });
  await wo.save();
  await logAction(userId, action, "WorkOrder", wo.id, `${wo.code} → ${to}`);
  return wo;
};

// 5.0 Repair & Log Parts
export const startWork = async (id, tech) => {
  const wo = await getTechWorkOrder(id, tech);
  return transition(wo, S.ASSIGNED, S.IN_PROGRESS, tech.id, "WO_START", { startedAt: wo.startedAt || new Date() });
};

export const putOnHold = async (id, tech, reason) => {
  const wo = await getTechWorkOrder(id, tech);
  await transition(wo, S.IN_PROGRESS, S.ON_HOLD, tech.id, "WO_HOLD", { holdReason: reason?.trim() || "Awaiting parts" });
  await notifyRoles("supervisor", {
    channel: "PUSH",
    title: `${wo.code} on hold`,
    message: `${tech.name} put ${wo.code} (Room ${wo.room.roomNo}) on hold: ${wo.holdReason}.`,
    link: `/work-orders/${wo.id}`,
  });
  return wo;
};

export const resumeWork = async (id, tech) => {
  const wo = await getTechWorkOrder(id, tech);
  return transition(wo, S.ON_HOLD, S.IN_PROGRESS, tech.id, "WO_RESUME", { holdReason: null });
};

export const logParts = async (id, tech, { itemId, qty }) => {
  const wo = await getTechWorkOrder(id, tech);
  if (![S.IN_PROGRESS, S.ON_HOLD].includes(wo.status)) throw new AppError(`Parts can only be logged while ${wo.code} is in progress or on hold.`);
  const amount = Number(qty);
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError("Quantity must be a whole number above 0.");

  const item = await sequelize.transaction(async (transaction) => {
    const stock = await InventoryItem.findByPk(itemId || 0, { transaction, lock: transaction.LOCK.UPDATE });
    if (!stock) throw new AppError("Choose a part from inventory.");
    if (stock.quantity < amount) {
      throw new AppError(`Only ${stock.quantity} ${stock.unit} of ${stock.name} in stock — put ${wo.code} on hold until parts arrive.`);
    }
    stock.quantity -= amount;
    await stock.save({ transaction });
    await PartUsage.create({ workOrderId: wo.id, itemId: stock.id, technicianId: tech.id, qty: amount }, { transaction });
    return stock;
  });

  await logAction(tech.id, "WO_PARTS", "WorkOrder", wo.id, `${wo.code}: ${amount} × ${item.name} (stock now ${item.quantity})`);
  await checkLowStock(item);
  return item;
};

export const resolveWorkOrder = async (id, tech, notes) => {
  const wo = await getTechWorkOrder(id, tech);
  if (!notes?.trim()) throw new AppError("Describe what was done to resolve the issue.");
  await transition(wo, S.IN_PROGRESS, S.RESOLVED, tech.id, "WO_RESOLVE", { resolvedAt: new Date(), resolutionNotes: notes.trim() });
  await notifyRoles("supervisor", {
    channel: "PUSH",
    title: `${wo.code} resolved — inspect Room ${wo.room.roomNo}`,
    message: `${tech.name}: ${wo.resolutionNotes}`,
    link: `/inspections/new?roomId=${wo.roomId}`,
  });
  return wo;
};

// Duplicate reports go straight to Cancelled (state machine: markDuplicate).
export const markDuplicate = async (id, supervisor, note) => {
  const wo = await getWorkOrder(id);
  await transition(wo, [S.OPEN, S.ASSIGNED], S.CANCELLED, supervisor.id, "WO_CANCEL", {
    resolutionNotes: `Cancelled as duplicate${note?.trim() ? `: ${note.trim()}` : ""}`, closedAt: new Date(),
  });
  if (wo.assignedToId) {
    await notifyUser(wo.assignedToId, { channel: "SMS", title: `${wo.code} cancelled`, message: `RoomCare: ${wo.code} (Room ${wo.room.roomNo}) was cancelled as a duplicate.`, link: `/work-orders/${wo.id}` });
  }
  return wo;
};
