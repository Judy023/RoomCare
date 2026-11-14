import { SystemLog } from "../models/index.js";

// Audit trail for the System Logs data store. Never lets a logging failure break the request.
export const logAction = async (userId, action, entity, entityId, details = "") => {
  try {
    await SystemLog.create({ userId: userId ?? null, action, entity, entityId, details });
  } catch (err) {
    console.error("❌ Could not write system log:", err.message);
  }
};

export const listLogs = (limit = 300) =>
  SystemLog.findAll({
    include: [{ association: "user", attributes: ["id", "name", "role"] }],
    order: [["createdAt", "DESC"]],
    limit,
  });
