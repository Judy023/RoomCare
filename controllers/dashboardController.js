import { LANDING } from "../middleware/auth.js";
import { board } from "../services/roomService.js";
import { vacantDirtyRooms, listTasks, assignFormOptions } from "../services/taskService.js";
import { listWorkOrders } from "../services/workOrderService.js";
import { inspectionQueue, awaitingCheckout } from "../services/inspectionService.js";
import { lowStockItems } from "../services/inventoryService.js";
import { TaskStatus, WorkOrderStatus } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

// Admins get the turnover overview; every other role lands on its own work list.
export const dashboardPage = wrap(async (req, res) => {
  const role = req.user.role;
  if (role !== "admin") return res.redirect(LANDING[role] || "/login");

  const [roomBoard, needTask, inProgress, openWos, onHold, toInspect, needCheckout, lowStock, assignOptions] = await Promise.all([
    board(),
    vacantDirtyRooms(),
    listTasks({ status: TaskStatus.IN_PROGRESS }),
    listWorkOrders({ status: WorkOrderStatus.OPEN }),
    listWorkOrders({ status: WorkOrderStatus.ON_HOLD }),
    inspectionQueue(),
    awaitingCheckout(),
    lowStockItems(),
    assignFormOptions(),
  ]);
  res.render("dashboard", {
    title: "Overview",
    counts: roomBoard.counts,
    totalRooms: roomBoard.total,
    needTask: toPlain(needTask),
    inProgress: toPlain(inProgress),
    openWos,
    onHold,
    toInspect,
    needCheckout: toPlain(needCheckout),
    lowStock: toPlain(lowStock),
    ...assignOptions,
  });
});
