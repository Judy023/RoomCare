
  /*
    MIT License

    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

import express from "express";
import { loadUser, requireAuth, requireRole } from "../middleware/auth.js";
import { handlePhotoUpload } from "../middleware/upload.js";
import { homePage } from "../controllers/homeController.js";
import { loginPage, registerPage, registerUser, forgotPasswordPage, loginUser, logoutUser } from "../controllers/authController.js";
import { dashboardPage } from "../controllers/dashboardController.js";
import { boardPage, roomPage, checkOutRoom, checkInRoom } from "../controllers/roomController.js";
import { tasksPage, createTask, myTasksPage, startMyTask, completeMyTask } from "../controllers/taskController.js";
import {
  workOrdersPage, myWorkOrdersPage, newWorkOrderPage, createWorkOrder, workOrderPage,
  assignWo, startWo, holdWo, resumeWo, logWoParts, resolveWo, cancelWo,
} from "../controllers/workOrderController.js";
import { inspectionsPage, newInspectionPage, createInspection } from "../controllers/inspectionController.js";
import { reportsPage, workOrdersCsvExport } from "../controllers/reportController.js";
import { notificationsPage, openNotification, readAllNotifications } from "../controllers/notificationController.js";
import { inventoryPage, createItemAction, updateItemAction, restockItemAction } from "../controllers/inventoryController.js";
import {
  usersPage, createUserAction, updateUserAction, roomsPage, createRoomAction, updateRoomAction, deleteRoomAction, logsPage,
} from "../controllers/adminController.js";
import {
  apiRooms, apiTaskStatus, apiCreateWorkOrder, apiNotifications, apiSendNotification, pmsWebhook,
} from "../controllers/apiController.js";

const router = express.Router();

// PMS webhook authenticates with its own token, not a session.
router.post("/api/pms/events", pmsWebhook);

router.use(loadUser);

router.get("/", homePage);
router.get("/login", loginPage);
router.post("/login", loginUser);
router.get("/register", registerPage);
router.post("/register", registerUser);
router.get("/forgot-password", forgotPasswordPage);
router.get("/logout", logoutUser);

router.use(requireAuth);

const supervisor = requireRole("supervisor", "admin");
const boardViewers = requireRole("supervisor", "admin");
const reporters = requireRole("housekeeper", "technician", "supervisor", "admin");

router.get("/dashboard", dashboardPage);

// Rooms / status board
router.get("/rooms", boardViewers, boardPage);
router.get("/rooms/:id", boardViewers, roomPage);
router.post("/rooms/:id/checkout", requireRole("admin"), checkOutRoom);
router.post("/rooms/:id/checkin", requireRole("admin"), checkInRoom);

// Cleaning tasks
router.get("/tasks", supervisor, tasksPage);
router.post("/tasks", supervisor, createTask);
router.get("/tasks/my", requireRole("housekeeper"), myTasksPage);
router.post("/tasks/:id/start", requireRole("housekeeper"), startMyTask);
router.post("/tasks/:id/complete", requireRole("housekeeper"), completeMyTask);

// Work orders
router.get("/work-orders", requireRole("supervisor", "admin", "technician"), workOrdersPage);
router.get("/work-orders/my", requireRole("technician"), myWorkOrdersPage);
router.get("/work-orders/new", reporters, newWorkOrderPage);
router.post("/work-orders", reporters, handlePhotoUpload, createWorkOrder);
router.get("/work-orders/:id", requireRole("supervisor", "admin", "technician", "housekeeper"), workOrderPage);
router.post("/work-orders/:id/assign", supervisor, assignWo);
router.post("/work-orders/:id/cancel", supervisor, cancelWo);
router.post("/work-orders/:id/start", requireRole("technician"), startWo);
router.post("/work-orders/:id/hold", requireRole("technician"), holdWo);
router.post("/work-orders/:id/resume", requireRole("technician"), resumeWo);
router.post("/work-orders/:id/parts", requireRole("technician"), logWoParts);
router.post("/work-orders/:id/resolve", requireRole("technician"), resolveWo);

// Inspections
router.get("/inspections", supervisor, inspectionsPage);
router.get("/inspections/new", supervisor, newInspectionPage);
router.post("/inspections", supervisor, createInspection);

// Inventory
router.get("/inventory", requireRole("supervisor", "technician", "admin"), inventoryPage);
router.post("/inventory", requireRole("admin"), createItemAction);
router.post("/inventory/:id", requireRole("admin"), updateItemAction);
router.post("/inventory/:id/restock", requireRole("admin"), restockItemAction);

// Reports
router.get("/reports", requireRole("admin"), reportsPage);
router.get("/reports/work-orders.csv", requireRole("admin"), workOrdersCsvExport);

// Notifications
router.get("/notifications", notificationsPage);
router.post("/notifications/read-all", readAllNotifications);
router.post("/notifications/:id/open", openNotification);

// System admin
const admin = requireRole("admin");
router.get("/admin/users", admin, usersPage);
router.post("/admin/users", admin, createUserAction);
router.post("/admin/users/:id", admin, updateUserAction);
router.get("/admin/rooms", admin, roomsPage);
router.post("/admin/rooms", admin, createRoomAction);
router.post("/admin/rooms/:id", admin, updateRoomAction);
router.post("/admin/rooms/:id/delete", admin, deleteRoomAction);
router.get("/admin/logs", admin, logsPage);

// JSON API for the mobile/PWA clients (session auth)
router.get("/api/rooms", apiRooms);
router.patch("/api/tasks/:id/status", requireRole("housekeeper"), apiTaskStatus);
router.post("/api/work-orders", reporters, handlePhotoUpload, apiCreateWorkOrder);
router.get("/api/notifications", apiNotifications);
router.post("/api/notifications", supervisor, apiSendNotification);

export default router;
