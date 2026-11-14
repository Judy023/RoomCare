import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const InventoryItem = sequelize.define("InventoryItem", {
  sku: { type: DataTypes.STRING, allowNull: false, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  category: { type: DataTypes.STRING },
  unit: { type: DataTypes.STRING, allowNull: false, defaultValue: "pc" },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  reorderLevel: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  unitCost: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  supplier: { type: DataTypes.STRING }
}, { tableName: "inventory_items" });
