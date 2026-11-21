import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { ROOM_STATUSES } from "./enums.js";

export const Room = sequelize.define("Room", {
  roomNo: { type: DataTypes.STRING, allowNull: false, unique: true },
  type: { type: DataTypes.STRING, allowNull: false },
  floor: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.ENUM(...ROOM_STATUSES), allowNull: false, defaultValue: "VACANT_DIRTY" },
  notes: { type: DataTypes.STRING },
  // Availability as last reported by the PMS (added by migrate-pms-hr-integration.js).
  // Only PMS events write these — RoomCare never sets the PMS availability itself.
  pmsStatus: { type: DataTypes.STRING(40) },
  pmsStatusAt: { type: DataTypes.DATE },
  // FrontDeskFlow synchronization (added by migrate-pms-hr-integration.js). externalId is the room's ID in the
  // front-desk system; it is what makes a repeated room sync an update instead of a duplicate.
  externalId: { type: DataTypes.STRING(100), unique: true },
  description: { type: DataTypes.TEXT },
  externalSyncedAt: { type: DataTypes.DATE }
});
