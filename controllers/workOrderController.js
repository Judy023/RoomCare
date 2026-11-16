import {
  listWorkOrders, getWorkOrder, withSla, reportIssue, assignWorkOrder,
  startWork, putOnHold, resumeWork, logParts, resolveWorkOrder, markDuplicate,
} from "../services/workOrderService.js";
import { listRooms } from "../services/roomService.js";
import { listStaff } from "../services/userService.js";
import { listItems } from "../services/inventoryService.js";
import { inspectionState } from "../services/inspectionService.js";
import { WO_STATUSES, WO_CATEGORIES, PRIORITIES, WorkOrderStatus as S } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

const filtersFrom = (query) => ({
  status: WO_STATUSES.includes(query.status) ? query.status : "",
  priority: PRIORITIES.includes(query.priority) ? query.priority : "",
  category: WO_CATEGORIES.includes(query.category) ? query.category : "",
});

export const workOrdersPage = wrap(async (req, res) => {
  const filters = filtersFrom(req.query);
  res.render("workorders/index", {
    title: "Work Orders",
    heading: "Work Orders",
    workOrders: await listWorkOrders(filters),
    filters, statuses: WO_STATUSES, categories: WO_CATEGORIES, priorities: PRIORITIES,
    action: "/work-orders",
  });
});

export const myWorkOrdersPage = wrap(async (req, res) => {
  const filters = filtersFrom(req.query);
  const workOrders = await listWorkOrders({ ...filters, assignedToId: req.user.id, activeOnly: !filters.status });
  res.render("workorders/index", {
    title: "My Work Orders",
    heading: "My Work Orders",
    subheading: filters.status ? "" : "Assigned to you and not yet closed. Pick a status to see older ones.",
    workOrders, filters, statuses: WO_STATUSES, categories: WO_CATEGORIES, priorities: PRIORITIES,
    action: "/work-orders/my",
  });
});

export const newWorkOrderPage = wrap(async (req, res) => {
  res.render("workorders/new", {
    title: "Report Maintenance Issue",
    rooms: toPlain(await listRooms()),
    categories: WO_CATEGORIES,
    priorities: PRIORITIES,
    roomId: req.query.roomId || "",
    taskId: req.query.taskId || "",
  });
});

export const createWorkOrder = wrap(async (req, res) => {
  const wo = await reportIssue(req.body, req.user, req.file);
  req.flash("success_msg", `${wo.code} reported — admins have been notified.`);
  res.redirect(req.user.role === "housekeeper" ? "/tasks/my" : `/work-orders/${wo.id}`);
});

export const workOrderPage = wrap(async (req, res) => {
  const wo = withSla(await getWorkOrder(req.params.id));
  const role = req.user.role;
  const isAdmin = role === "admin";
  const mine = wo.assignedToId === req.user.id;
  const [technicians, items, roomState] = await Promise.all([
    isAdmin ? listStaff("technician") : [],
    mine ? listItems() : [],
    inspectionState(wo.room),
  ]);
  res.render("workorders/show", {
    title: wo.code,
    wo,
    technicians: toPlain(technicians),
    items: toPlain(items),
    priorities: PRIORITIES,
    can: {
      assign: isAdmin && [S.OPEN, S.ASSIGNED].includes(wo.status),
      cancel: isAdmin && [S.OPEN, S.ASSIGNED].includes(wo.status),
      start: mine && wo.status === S.ASSIGNED,
      hold: mine && wo.status === S.IN_PROGRESS,
      resume: mine && wo.status === S.ON_HOLD,
      logParts: mine && [S.IN_PROGRESS, S.ON_HOLD].includes(wo.status),
      resolve: mine && wo.status === S.IN_PROGRESS,
      inspect: isAdmin && wo.status === S.RESOLVED && roomState.ok,
    },
    timeline: [
      { label: "Reported", at: wo.reportedAt, by: wo.reportedBy?.name },
      { label: "Assigned", at: wo.assignedAt, by: wo.assignedTo?.name },
      { label: "Work started", at: wo.startedAt },
      { label: "Resolved", at: wo.resolvedAt },
      { label: wo.status === S.CANCELLED ? "Cancelled" : "Closed (inspection passed)", at: wo.closedAt },
    ],
  });
});

const back = (req, res, message) => {
  req.flash("success_msg", message);
  res.redirect(`/work-orders/${req.params.id}`);
};

export const assignWo = wrap(async (req, res) => {
  const wo = await assignWorkOrder(req.params.id, req.body, req.user);
  back(req, res, `${wo.code} assigned — SMS sent to the technician.`);
});
export const startWo = wrap(async (req, res) => {
  const wo = await startWork(req.params.id, req.user);
  back(req, res, `${wo.code} accepted — work in progress.`);
});
export const holdWo = wrap(async (req, res) => {
  const wo = await putOnHold(req.params.id, req.user, req.body.reason);
  back(req, res, `${wo.code} put on hold.`);
});
export const resumeWo = wrap(async (req, res) => {
  const wo = await resumeWork(req.params.id, req.user);
  back(req, res, `${wo.code} back in progress.`);
});
export const logWoParts = wrap(async (req, res) => {
  const item = await logParts(req.params.id, req.user, req.body);
  back(req, res, `Logged ${req.body.qty} × ${item.name}. ${item.quantity} ${item.unit} left in stock.`);
});
export const resolveWo = wrap(async (req, res) => {
  const wo = await resolveWorkOrder(req.params.id, req.user, req.body.notes);
  back(req, res, `${wo.code} resolved — an admin has been asked to inspect the room.`);
});
export const cancelWo = wrap(async (req, res) => {
  const wo = await markDuplicate(req.params.id, req.user, req.body.note);
  back(req, res, `${wo.code} cancelled as a duplicate.`);
});
