import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { WO_STATUSES, PRIORITIES } from "./enums.js";

export const WorkOrder = sequelize.define("WorkOrder", {
  code: { type: DataTypes.STRING, unique: true },
  category: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: false },
  priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: "MEDIUM" },
  status: { type: DataTypes.ENUM(...WO_STATUSES), allowNull: false, defaultValue: "OPEN" },
  photoUrl: { type: DataTypes.STRING },
  holdReason: { type: DataTypes.STRING },
  resolutionNotes: { type: DataTypes.TEXT },
  reportedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  assignedAt: { type: DataTypes.DATE },
  startedAt: { type: DataTypes.DATE },
  resolvedAt: { type: DataTypes.DATE },
  closedAt: { type: DataTypes.DATE }
}, { tableName: "work_orders" });
