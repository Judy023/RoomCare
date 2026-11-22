// HTTP client for the FrontDesk API (ROOM_SYNC.pdf). The only place that knows its base URL, API key and signing.
//
//   GET  /housekeeping/rooms                 fetchRooms()
//   GET  /housekeeping/rooms/{room_number}   fetchRoom(roomNumber)
//   POST /housekeeping/cleaning-status       postCleaningStatus(body, idempotencyKey)
//
// Every call carries the API key. Every POST also carries Idempotency-Key, X-Timestamp and
//   X-Signature = "sha256=" + hex(HMAC-SHA256(signing secret, X-Timestamp + "." + raw body))
// computed over the exact bytes sent. Responses are { success, data } or { success:false, error:{ code, message, details } }.
import crypto from "crypto";
import { FRONTDESK_API } from "../config/integrations.js";

// Per the document (§9.3): retry network errors, timeouts, 408/425/429, 5xx and 409 REQUEST_IN_PROGRESS; never other 4xx.
const RETRYABLE_STATUS = new Set([408, 425, 429]);
// 409 answers that mean "this is already recorded": the update has effectively been delivered (§9.2).
export const ALREADY_DONE_CODES = new Set(["DUPLICATE_TASK", "TASK_ALREADY_STARTED", "DUPLICATE_CLEANING_COMPLETION"]);

export class FrontDeskApiError extends Error {
  constructor(message, { status = null, code = null, body = null, network = false } = {}) {
    super(message);
    this.name = "FrontDeskApiError";
    this.status = status;   // HTTP status from FrontDesk (null when it never answered)
    this.code = code;       // FrontDesk's machine code, e.g. ROOM_NOT_FOUND, INVALID_SIGNATURE
    this.body = body;
    this.network = network; // timeout / connection failure
    this.retryable = network || RETRYABLE_STATUS.has(status) || (status >= 500) || (status === 409 && code === "REQUEST_IN_PROGRESS");
    this.alreadyDone = status === 409 && ALREADY_DONE_CODES.has(code);
  }
}

export const isConfigured = () => Boolean(FRONTDESK_API.baseUrl);

const authHeaders = () => {
  if (!FRONTDESK_API.token) return {};
  return { [FRONTDESK_API.authHeader]: `${FRONTDESK_API.authScheme ? FRONTDESK_API.authScheme + " " : ""}${FRONTDESK_API.token}` };
};

export const signBody = (secret, timestamp, raw) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");

const request = async (method, path, body, idempotencyKey) => {
  if (!isConfigured()) throw new FrontDeskApiError("FRONTDESK_API_BASE_URL is not configured");
  const headers = { Accept: "application/json", ...authHeaders() };
  let raw;
  if (body !== undefined) {
    if (!FRONTDESK_API.signingSecret) throw new FrontDeskApiError("FRONTDESK_API_SIGNING_SECRET is not set: FrontDesk refuses unsigned writes");
    raw = JSON.stringify(body); // serialised once: the signature covers exactly these bytes
    const timestamp = Math.floor(Date.now() / 1000).toString();
    Object.assign(headers, {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-Timestamp": timestamp,
      "X-Signature": signBody(FRONTDESK_API.signingSecret, timestamp, raw),
    });
  }
  let res;
  try {
    res = await fetch(FRONTDESK_API.baseUrl + path, { method, headers, body: raw, signal: AbortSignal.timeout(FRONTDESK_API.timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new FrontDeskApiError(`${method} ${path}: ${timedOut ? `no answer within ${FRONTDESK_API.timeoutMs} ms` : `connection failed (${err.cause?.code || err.message})`}`, { network: true });
  }
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
  if (!res.ok || data?.success === false) {
    const code = data?.error?.code ?? null;
    const message = data?.error?.message ?? (typeof data === "string" ? data : "");
    const detail = data?.error?.details ? ` ${JSON.stringify(data.error.details)}` : "";
    throw new FrontDeskApiError(
      `${method} ${path}: FrontDesk answered HTTP ${res.status}${code ? ` ${code}` : ""}${message ? `: ${String(message).slice(0, 300)}` : ""}${detail.slice(0, 300)}`,
      { status: res.status, code, body: data },
    );
  }
  return { status: res.status, data, text, replayed: res.headers.get("Idempotent-Replayed") === "true" };
};

export const fetchRooms = () => request("GET", FRONTDESK_API.paths.rooms);

export const fetchRoom = (roomNumber) =>
  request("GET", FRONTDESK_API.paths.room.replace("{roomNumber}", encodeURIComponent(String(roomNumber))));

export const postCleaningStatus = (body, idempotencyKey) => request("POST", FRONTDESK_API.paths.cleaningStatus, body, idempotencyKey);
