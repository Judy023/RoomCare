// Loads every RoomCare model and wires up the associations from the class diagram.
import { sequelize } from "./db.js";
import { User } from "./userModel.js";
import { Room } from "./roomModel.js";
import { CleaningTask } from "./cleaningTaskModel.js";
import { WorkOrder } from "./workOrderModel.js";
import { InventoryItem } from "./inventoryItemModel.js";
import { PartUsage } from "./partUsageModel.js";
import { Inspection } from "./inspectionModel.js";
import { Notification } from "./notificationModel.js";
import { SystemLog } from "./systemLogModel.js";

// Admin assigns, Housekeeper performs, CleaningTask is for a Room
// (the assigning admin is stored in adminId / "admin" alias)
Room.hasMany(CleaningTask, { as: "tasks", foreignKey: "roomId" });
CleaningTask.belongsTo(Room, { as: "room", foreignKey: "roomId" });
User.hasMany(CleaningTask, { as: "assignedTasks", foreignKey: "housekeeperId" });
CleaningTask.belongsTo(User, { as: "housekeeper", foreignKey: "housekeeperId" });
CleaningTask.belongsTo(User, { as: "admin", foreignKey: "adminId" });

// Housekeeper reports a WorkOrder against a Room, Technician resolves it
Room.hasMany(WorkOrder, { as: "workOrders", foreignKey: "roomId" });
WorkOrder.belongsTo(Room, { as: "room", foreignKey: "roomId" });
WorkOrder.belongsTo(User, { as: "reportedBy", foreignKey: "reportedById" });
WorkOrder.belongsTo(User, { as: "assignedTo", foreignKey: "assignedToId" });
WorkOrder.belongsTo(CleaningTask, { as: "task", foreignKey: "taskId" });

// WorkOrder is composed of PartUsage records drawn from InventoryItems
WorkOrder.hasMany(PartUsage, { as: "parts", foreignKey: "workOrderId", onDelete: "CASCADE" });
PartUsage.belongsTo(WorkOrder, { as: "workOrder", foreignKey: "workOrderId" });
InventoryItem.hasMany(PartUsage, { as: "usages", foreignKey: "itemId" });
PartUsage.belongsTo(InventoryItem, { as: "item", foreignKey: "itemId" });
PartUsage.belongsTo(User, { as: "technician", foreignKey: "technicianId" });

// Admin conducts an Inspection of the Room
Room.hasMany(Inspection, { as: "inspections", foreignKey: "roomId" });
Inspection.belongsTo(Room, { as: "room", foreignKey: "roomId" });
Inspection.belongsTo(User, { as: "admin", foreignKey: "adminId" });
Inspection.belongsTo(CleaningTask, { as: "task", foreignKey: "taskId" });

User.hasMany(Notification, { as: "notifications", foreignKey: "recipientId", onDelete: "CASCADE" });
Notification.belongsTo(User, { as: "recipient", foreignKey: "recipientId" });

SystemLog.belongsTo(User, { as: "user", foreignKey: "userId" });

export { sequelize, User, Room, CleaningTask, WorkOrder, InventoryItem, PartUsage, Inspection, Notification, SystemLog };
