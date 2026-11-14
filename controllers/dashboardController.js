import { LANDING } from "../middleware/auth.js";
import { board } from "../services/roomService.js";
import { roomsNeedingTask, listTasks } from "../services/taskService.js";
import { listWorkOrders } from "../services/workOrderService.js";
import { pendingRooms } from "../services/inspectionService.js";
import { lowStockItems } from "../services/inventoryService.js";
import { TaskStatus, WorkOrderStatus } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

// Supervisors and admins get the turnover overview; every other role lands on its own work list.
export const dashboardPage = wrap(async (req, res) => {
  const role = req.user.role;
  if (!["supervisor", "admin"].includes(role)) return res.redirect(LANDING[role] || "/login");

  const [roomBoard, needTask, inProgress, openWos, onHold, toInspect, lowStock] = await Promise.all([
    board(),
    roomsNeedingTask(),
    listTasks({ status: TaskStatus.IN_PROGRESS }),
    listWorkOrders({ status: WorkOrderStatus.OPEN }),
    listWorkOrders({ status: WorkOrderStatus.ON_HOLD }),
    pendingRooms(),
    lowStockItems(),
  ]);
  res.render("dashboard", {
    title: "Overview",
    counts: roomBoard.counts,
    totalRooms: roomBoard.total,
    needTask: toPlain(needTask),
    inProgress: toPlain(inProgress),
    openWos,
    onHold,
    toInspect: toPlain(toInspect),
    lowStock: toPlain(lowStock),
  });
});
