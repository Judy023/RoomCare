import crypto from "crypto";
import { PMS, FRONTDESK, STAFFPAY } from "../config/integrations.js";
import { logAction } from "../services/logService.js";

// System-to-system authentication for /api/integrations/*. No session or user account is involved.
// A caller sends its key as "Authorization: Bearer <key>" or "X-API-Key: <key>". Each system has its own key
// and can only reach its own routes.
const SYSTEMS = {
  frontdesk: { name: "FrontDeskFlow", key: () => FRONTDESK.apiKey, disabled: () => PMS.mode === "disabled", envVar: "FRONTDESK_API_KEY" },
  staffpay: { name: "StaffPay", key: () => STAFFPAY.apiKey, disabled: () => false, envVar: "STAFFPAY_API_KEY" },
};

const tokenMatches = (given, expected) => {
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

export const errorBody = (status, code, message, details) => ({ success: false, error: { code, message, ...(details ? { details } : {}) } });

// Logs every integration request (who, what, result, time) to the System Logs. Never logs bodies or keys.
const logRequests = (system) => (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    logAction(null, "INTEGRATION_API", SYSTEMS[system].name, null,
      `${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode} (${Date.now() - started} ms, ${req.ip})`);
  });
  next();
};

const authenticate = (system) => (req, res, next) => {
  const cfg = SYSTEMS[system];
  if (cfg.disabled()) return res.status(503).json(errorBody(503, "INTEGRATION_DISABLED", `${cfg.name} integration is disabled`));
  const expected = cfg.key();
  const other = SYSTEMS[system === "frontdesk" ? "staffpay" : "frontdesk"].key();
  if (!expected) return res.status(503).json(errorBody(503, "NOT_CONFIGURED", `${cfg.name} integration is not configured (${cfg.envVar})`));
  // Scope separation only works if the two systems do not share a key.
  if (expected === other) return res.status(503).json(errorBody(503, "KEY_MISCONFIGURED", "FRONTDESK_API_KEY and STAFFPAY_API_KEY must be different"));
  const given = req.get("X-API-Key") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given) return res.status(401).json(errorBody(401, "UNAUTHORIZED", "Missing API key. Send Authorization: Bearer <key> or X-API-Key."));
  if (!tokenMatches(given, expected)) {
    // A valid key for the other system is a permission problem, not an unknown key.
    if (tokenMatches(given, other)) return res.status(403).json(errorBody(403, "FORBIDDEN", `This key is not permitted to use ${cfg.name} endpoints`));
    return res.status(401).json(errorBody(401, "UNAUTHORIZED", "Invalid API key"));
  }
  next();
};

export const integrationGuard = (system) => [logRequests(system), authenticate(system)];
