import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const Inspection = sequelize.define("Inspection", {
  result: { type: DataTypes.ENUM("PASS", "FAIL"), allowNull: false },
  // [{ key, label, kind, passed }]
  checklist: { type: DataTypes.JSON, allowNull: false },
  remarks: { type: DataTypes.TEXT }
}, { tableName: "inspections" });
