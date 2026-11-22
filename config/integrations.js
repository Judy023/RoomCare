import "./env.js";

// Integration settings. Secrets come only from the environment (or .env) and are never shown in the UI.
const mode = (v, allowed, fallback) => (allowed.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : fallback);
const isProd = process.env.NODE_ENV === "production";

// Development-only fallback for the inbound PMS token, so the existing local setup keeps working.
// In production the token must be configured or the webhook refuses every request.
const DEV_PMS_TOKEN = "roomcare-pms-dev-token";

export const PMS = {
  // mock     → outgoing events are recorded and marked "sent (mock)"; nothing leaves the server
  // live     → outgoing events are POSTed to PMS_OUTBOUND_URL
  // disabled → the PMS webhook refuses events and nothing is queued
  mode: mode(process.env.PMS_MODE, ["mock", "live", "disabled"], "mock"),
  inboundToken: process.env.PMS_WEBHOOK_TOKEN || (isProd ? "" : DEV_PMS_TOKEN),
  usingDevToken: !process.env.PMS_WEBHOOK_TOKEN && !isProd,
  outboundUrl: process.env.PMS_OUTBOUND_URL || "",
  outboundToken: process.env.PMS_OUTBOUND_TOKEN || "",
  signingSecret: process.env.PMS_SIGNING_SECRET || "",
  // When RoomCare tells the PMS a room is clean: right after the housekeeper finishes (task_completed)
  // or only after an admin's inspection passes (inspection_passed).
  notifyOn: mode(process.env.PMS_NOTIFY_ON, ["task_completed", "inspection_passed"], "task_completed"),
  timeoutMs: Number(process.env.PMS_TIMEOUT_MS) || 10000,
  maxAttempts: Number(process.env.PMS_MAX_ATTEMPTS) || 6,
  // Testing aid: makes mock deliveries fail so the retry path can be exercised.
  mockFail: process.env.PMS_MOCK_FAIL === "1",
};

export const HR = {
  apiToken: process.env.HR_API_TOKEN || "",
};

// ── /api/integrations/* (FrontDeskFlow = the PMS above, StaffPay = the HR/Payroll system above) ─────────
// Each external system has its own inbound key, so a FrontDeskFlow key can never read StaffPay data.
// The older variables (PMS_WEBHOOK_TOKEN, HR_API_TOKEN) are used when the new ones are not set.
export const FRONTDESK = {
  apiKey: process.env.FRONTDESK_API_KEY || PMS.inboundToken,
};
export const STAFFPAY = {
  apiKey: process.env.STAFFPAY_API_KEY || HR.apiToken,
};

// How outgoing requests to FrontDeskFlow are shaped. The URL itself is PMS_OUTBOUND_URL; these exist so the
// real contract can be matched by configuration once the FrontDeskFlow developers publish it.
PMS.outboundMethod = mode(process.env.PMS_OUTBOUND_METHOD, ["post", "put", "patch"], "post").toUpperCase();
PMS.outboundAuthHeader = process.env.PMS_OUTBOUND_AUTH_HEADER || "Authorization";
PMS.outboundAuthScheme = process.env.PMS_OUTBOUND_AUTH_SCHEME ?? "Bearer"; // "" sends the bare token (API-key style)

// ── FrontDesk API (contract: "Connecting RoomCare to the FrontDesk", ROOM_SYNC.pdf, 2026-11-21) ───────
//   POST /housekeeping/cleaning-status   RoomCare → FrontDesk  cleaning status (signed, Idempotency-Key)
//   GET  /housekeeping/rooms             RoomCare reads all rooms
//   GET  /housekeeping/rooms/{room_number}                      one room
// Base URL is https://<frontdesk-host>/api/v1/integrations (the host is still to be provided by FrontDesk).
// Authentication: API key in X-Api-Key; every POST is signed with the inbound secret (see services/frontdeskApiClient.js).
// Webhooks FrontDesk sends to RoomCare are verified with the webhook secret (see services/frontdeskWebhookService.js).
const envInt = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
export const FRONTDESK_API = {
  baseUrl: (process.env.FRONTDESK_API_BASE_URL || "").trim().replace(/\/+$/, ""),
  token: process.env.FRONTDESK_API_TOKEN || "",                       // FrontDesk's HOUSEKEEPING_API_KEY
  authHeader: process.env.FRONTDESK_API_AUTH_HEADER || "X-Api-Key",   // "Authorization" + scheme "Bearer" also works
  authScheme: process.env.FRONTDESK_API_AUTH_SCHEME ?? "",            // "" sends the bare key
  signingSecret: process.env.FRONTDESK_API_SIGNING_SECRET || "",      // FrontDesk's HOUSEKEEPING_INBOUND_SECRET (signs our POSTs)
  webhookSecret: process.env.FRONTDESK_WEBHOOK_SECRET || "",          // FrontDesk's HOUSEKEEPING_WEBHOOK_SECRET (verifies its webhooks)
  timeoutMs: envInt(process.env.FRONTDESK_API_TIMEOUT_MS, PMS.timeoutMs),
  paths: {
    cleaningStatus: process.env.FRONTDESK_PATH_CLEANING_STATUS || "/housekeeping/cleaning-status",
    rooms: process.env.FRONTDESK_PATH_ROOMS || "/housekeeping/rooms",
    room: process.env.FRONTDESK_PATH_ROOM || "/housekeeping/rooms/{roomNumber}",
  },
  // Minutes between automatic room syncs. 0 (default) = no background sync; run `npm run sync:frontdesk` instead.
  syncIntervalMinutes: Number(process.env.FRONTDESK_SYNC_INTERVAL_MINUTES) || 0,
};

// Safe summary for the admin screen: says what is configured, never the values.
export const integrationConfigSummary = () => ({
  pms: {
    mode: PMS.mode,
    notifyOn: PMS.notifyOn,
    inboundTokenSet: Boolean(process.env.PMS_WEBHOOK_TOKEN),
    usingDevToken: PMS.usingDevToken,
    outboundUrlSet: Boolean(PMS.outboundUrl),
    outboundTokenSet: Boolean(PMS.outboundToken),
    signingSecretSet: Boolean(PMS.signingSecret),
    liveReady: PMS.mode === "live" && Boolean(PMS.outboundUrl),
    maxAttempts: PMS.maxAttempts,
  },
  hr: { apiTokenSet: Boolean(HR.apiToken) },
});
