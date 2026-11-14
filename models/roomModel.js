import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { ROOM_STATUSES } from "./enums.js";

export const Room = sequelize.define("Room", {
  roomNo: { type: DataTypes.STRING, allowNull: false, unique: true },
  type: { type: DataTypes.STRING, allowNull: false },
  floor: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.ENUM(...ROOM_STATUSES), allowNull: false, defaultValue: "VACANT_DIRTY" },
  notes: { type: DataTypes.STRING }
});
