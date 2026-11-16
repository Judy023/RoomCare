import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";
import { INTEGRATION_SYSTEMS, INTEGRATION_DIRECTIONS, INTEGRATION_STATUSES } from "./enums.js";

// Every event exchanged with an external system (PMS, HR/Payroll), in or out.
// (system, direction, eventId) is unique, which is what stops a repeated event from being processed twice.
export const IntegrationEvent = sequelize.define("IntegrationEvent", {
  system: { type: DataTypes.ENUM(...INTEGRATION_SYSTEMS), allowNull: false },
  direction: { type: DataTypes.ENUM(...INTEGRATION_DIRECTIONS), allowNull: false },
  eventType: { type: DataTypes.STRING(64), allowNull: false },
  eventId: { type: DataTypes.STRING(100), allowNull: false },
  status: { type: DataTypes.ENUM(...INTEGRATION_STATUSES), allowNull: false },
  occurredAt: { type: DataTypes.DATE },
  payload: { type: DataTypes.JSON },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  nextAttemptAt: { type: DataTypes.DATE },
  lastError: { type: DataTypes.TEXT },
  response: { type: DataTypes.TEXT },
  duplicateCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  processedAt: { type: DataTypes.DATE },
}, {
  tableName: "integration_events",
  indexes: [
    { unique: true, fields: ["system", "direction", "eventId"], name: "integration_events_unique_event" },
    { fields: ["status", "nextAttemptAt"], name: "integration_events_due" },
  ],
});
