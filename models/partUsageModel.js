import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const PartUsage = sequelize.define("PartUsage", {
  qty: { type: DataTypes.INTEGER, allowNull: false }
}, { tableName: "part_usages" });
