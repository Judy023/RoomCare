import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { TASK_STATUSES, TASK_TYPES, PRIORITIES, TASK_SOURCES } from "./enums.js";

export const CleaningTask = sequelize.define("CleaningTask", {
  code: { type: DataTypes.STRING, unique: true },
  taskType: { type: DataTypes.ENUM(...Object.keys(TASK_TYPES)), allowNull: false, defaultValue: "CHECKOUT_CLEAN" },
  title: { type: DataTypes.STRING, allowNull: false },
  priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: "MEDIUM" },
  status: { type: DataTypes.ENUM(...TASK_STATUSES), allowNull: false, defaultValue: "PENDING" },
  notes: { type: DataTypes.TEXT },
  dueAt: { type: DataTypes.DATE },
  startedAt: { type: DataTypes.DATE },
  completedAt: { type: DataTypes.DATE },
  inspectedAt: { type: DataTypes.DATE },
  // Integration fields (added by migrate-pms-hr-integration.js)
  source: { type: DataTypes.ENUM(...TASK_SOURCES), allowNull: false, defaultValue: "MANUAL" },
  assignedAt: { type: DataTypes.DATE },
  hrExportedAt: { type: DataTypes.DATE },
  hrExportBatch: { type: DataTypes.STRING(100) }
}, { tableName: "cleaning_tasks" });
