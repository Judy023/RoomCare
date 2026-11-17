import { Inspection, Room, CleaningTask, WorkOrder, User } from "../models/index.js";
import {
  RoomStatus, TaskStatus, WorkOrderStatus, InspectionResult,
  ACTIVE_TASK_STATUSES, ACTIVE_WO_STATUSES, INSPECTION_CHECKLIST,
} from "../models/enums.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyUser } from "./notificationService.js";
import { getRoom, setStatus } from "./roomService.js";
import { queueCleaningCompleted } from "./pmsIntegrationService.js";
import { PMS } from "../config/integrations.js";

const INSPECTABLE = [RoomStatus.VACANT_CLEAN, RoomStatus.OUT_OF_ORDER];

// A room can be inspected once it is cleaned and every repair on it has been resolved.
export const inspectionState = async (room) => {
  if (!INSPECTABLE.includes(room.status)) {
    return { ok: false, reason: `Room ${room.roomNo} must be clean (or out of order with its repairs resolved) to be inspected.` };
  }
  const openTask = await CleaningTask.findOne({ where: { roomId: room.id, status: ACTIVE_TASK_STATUSES } });
  if (openTask) return { ok: false, reason: `Room ${room.roomNo} still has an open cleaning task (${openTask.code}).` };
  const openWo = await WorkOrder.findOne({ where: { roomId: room.id, status: ACTIVE_WO_STATUSES } });
  if (openWo) return { ok: false, reason: `Room ${room.roomNo} still has an unresolved work order (${openWo.code}).` };
  return { ok: true };
};

export const pendingRooms = async () => {
  const rooms = await Room.findAll({
    where: { status: INSPECTABLE },
    include: [
      { model: CleaningTask, as: "tasks", required: false, where: { status: [...ACTIVE_TASK_STATUSES, TaskStatus.DONE] }, include: [{ model: User, as: "housekeeper", attributes: ["id", "name"] }] },
      { model: WorkOrder, as: "workOrders", required: false, where: { status: [...ACTIVE_WO_STATUSES, WorkOrderStatus.RESOLVED] } },
    ],
    order: [["floor", "ASC"], ["roomNo", "ASC"]],
  });
  return rooms.filter((room) =>
    !room.tasks.some((t) => ACTIVE_TASK_STATUSES.includes(t.status)) &&
    !room.workOrders.some((w) => ACTIVE_WO_STATUSES.includes(w.status)));
};

// Admin overview: every vacant clean room (ready or not), plus out-of-order rooms whose repairs are all resolved.
// `ready` = it can be inspected now; otherwise `waitingFor` says what is still open.
export const inspectionQueue = async () => {
  const rooms = await Room.findAll({
    where: { status: INSPECTABLE },
    include: [
      { model: CleaningTask, as: "tasks", required: false, where: { status: ACTIVE_TASK_STATUSES } },
      { model: WorkOrder, as: "workOrders", required: false, where: { status: [...ACTIVE_WO_STATUSES, WorkOrderStatus.RESOLVED] } },
    ],
    order: [["floor", "ASC"], ["roomNo", "ASC"]],
  });
  return rooms
    .map((room) => {
      const openTask = room.tasks[0];
      const openWo = room.workOrders.find((w) => ACTIVE_WO_STATUSES.includes(w.status));
      const resolved = room.workOrders.filter((w) => w.status === WorkOrderStatus.RESOLVED).length;
      const waitingFor = openTask ? `cleaning task ${openTask.code}` : openWo ? `work order ${openWo.code}` : null;
      return { ...room.get({ plain: true }), ready: !waitingFor, waitingFor, resolved };
    })
    .filter((room) => room.status === RoomStatus.VACANT_CLEAN || room.ready);
};

// Occupied rooms with a resolved repair: they can only be inspected after the guest checks out.
export const awaitingCheckout = () =>
  Room.findAll({
    where: { status: RoomStatus.OCCUPIED },
    include: [{ model: WorkOrder, as: "workOrders", required: true, where: { status: WorkOrderStatus.RESOLVED } }],
    order: [["floor", "ASC"], ["roomNo", "ASC"]],
  });

export const listInspections = (limit = 50) =>
  Inspection.findAll({
    include: [{ model: Room, as: "room" }, { model: User, as: "admin", attributes: ["id", "name"] }],
    order: [["createdAt", "DESC"]],
    limit,
  });

export const inspectionContext = async (roomId) => {
  const room = await getRoom(roomId);
  const state = await inspectionState(room);
  const lastTask = await CleaningTask.findOne({
    where: { roomId: room.id, status: TaskStatus.DONE }, order: [["completedAt", "DESC"]],
    include: [{ model: User, as: "housekeeper", attributes: ["id", "name"] }],
  });
  const resolvedWos = await WorkOrder.findAll({
    where: { roomId: room.id, status: WorkOrderStatus.RESOLVED },
    include: [{ model: User, as: "assignedTo", attributes: ["id", "name"] }],
  });
  return { room, state, lastTask, resolvedWos };
};

// 6.0 Inspect & Release Room. Every checklist item ticked = PASS.
export const recordInspection = async (roomId, admin, { items, remarks }) => {
  const { room, state, lastTask, resolvedWos } = await inspectionContext(roomId);
  if (!state.ok) throw new AppError(state.reason);

  const ticked = [].concat(items || []);
  const checklist = INSPECTION_CHECKLIST.map((c) => ({ ...c, passed: ticked.includes(c.key) }));
  const failed = checklist.filter((c) => !c.passed);
  const result = failed.length ? InspectionResult.FAIL : InspectionResult.PASS;

  const inspection = await Inspection.create({
    roomId: room.id, adminId: admin.id, taskId: lastTask?.id ?? null, result, checklist, remarks: remarks?.trim() || null,
  });
  const now = new Date();

  if (result === InspectionResult.PASS) {
    await setStatus(room, RoomStatus.INSPECTED, admin.id, "inspection passed");
    await CleaningTask.update({ status: TaskStatus.INSPECTED, inspectedAt: now }, { where: { roomId: room.id, status: TaskStatus.DONE } });
    for (const wo of resolvedWos) await wo.update({ status: WorkOrderStatus.CLOSED, closedAt: now });
    await logAction(admin.id, "INSPECTION_PASS", "Room", room.id, `Room ${room.roomNo} released${resolvedWos.length ? `, closed ${resolvedWos.map((w) => w.code).join(", ")}` : ""}`);
    // With PMS_NOTIFY_ON=inspection_passed the PMS hears about the clean room only once it is verified.
    if (lastTask && PMS.notifyOn === "inspection_passed") {
      queueCleaningCompleted(await lastTask.reload(), "PASSED");
    }
    return { inspection, result };
  }

  // Failed: a maintenance item reopens resolved repairs, a cleaning item reopens the housekeeper's task.
  const failedLabels = failed.map((c) => c.label).join("; ");
  const reopened = failed.some((c) => c.kind === "maintenance") ? resolvedWos : [];
  for (const wo of reopened) {
    await wo.update({ status: WorkOrderStatus.IN_PROGRESS, resolvedAt: null });
    if (wo.assignedToId) {
      await notifyUser(wo.assignedToId, {
        channel: "SMS",
        title: `${wo.code} reopened`,
        message: `RoomCare: Room ${room.roomNo} failed inspection (${failedLabels}). ${wo.code} has been reopened.`,
        link: `/work-orders/${wo.id}`,
      });
    }
  }

  const failedCleaning = failed.some((c) => c.kind === "cleaning");
  if (failedCleaning && lastTask) {
    lastTask.status = TaskStatus.PENDING;
    lastTask.startedAt = null;
    lastTask.completedAt = null;
    lastTask.notes = [lastTask.notes, `Re-clean after failed inspection: ${failedLabels}${remarks?.trim() ? ` — ${remarks.trim()}` : ""}`].filter(Boolean).join("\n");
    await lastTask.save();
    await notifyUser(lastTask.housekeeperId, {
      channel: "PUSH",
      title: `Touch-up needed: Room ${room.roomNo}`,
      message: `${admin.name} sent ${lastTask.code} back: ${failedLabels}.`,
      link: "/tasks/my",
    });
  }

  if (reopened.length) await setStatus(room, RoomStatus.OUT_OF_ORDER, admin.id, "inspection failed, repair reopened");
  else if (failedCleaning) await setStatus(room, RoomStatus.VACANT_DIRTY, admin.id, "inspection failed, needs re-clean");
  await logAction(admin.id, "INSPECTION_FAIL", "Room", room.id, `Room ${room.roomNo}: ${failedLabels}`);
  return { inspection, result, reopenedTask: failedCleaning && lastTask ? lastTask : null, reopenedWos: reopened, needsNewTask: failedCleaning && !lastTask };
};
