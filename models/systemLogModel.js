import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const SystemLog = sequelize.define("SystemLog", {
  action: { type: DataTypes.STRING, allowNull: false },
  entity: { type: DataTypes.STRING },
  entityId: { type: DataTypes.INTEGER },
  details: { type: DataTypes.TEXT }
}, { tableName: "system_logs", updatedAt: false });
