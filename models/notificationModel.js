import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { CHANNELS } from "./enums.js";

export const Notification = sequelize.define("Notification", {
  channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false, defaultValue: "IN_APP" },
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  link: { type: DataTypes.STRING },
  isRead: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  sentAt: { type: DataTypes.DATE }
}, { tableName: "notifications" });
