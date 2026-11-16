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
