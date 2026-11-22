# RoomCare ⇄ FrontDesk integration

Implements FrontDesk's document **"Connecting RoomCare to the FrontDesk" (ROOM_SYNC.pdf, 2026-11-21)**.

| Direction | What | Where in RoomCare |
|---|---|---|
| FrontDesk → RoomCare | webhooks `RoomVacated`, `RoomStatusChanged`, `RoomCleaned` (signed) | `POST /api/frontdesk/webhook` · `services/frontdeskWebhookService.js` |
| RoomCare → FrontDesk | `POST /housekeeping/cleaning-status` (signed, idempotent) | `services/pmsIntegrationService.js` · `services/frontdeskApiClient.js` |
| RoomCare → FrontDesk | `GET /housekeeping/rooms`, `GET /housekeeping/rooms/{room_number}` | `services/frontdeskSyncService.js` · `npm run sync:frontdesk` |

Config in `config/integrations.js` (`FRONTDESK_API`) and `config/frontdeskApiMapping.js` (field/status mapping, defaults = the document).

## Status: built to the document, NOT yet run against the real FrontDesk

The document says it too: *no live test with the real RoomCare has been done*. We have no FrontDesk host or credentials yet. `npm test` (24 tests) runs RoomCare against a local **stub that behaves as the document describes** (envelope, API key, signed POSTs, Idempotency-Key replay, per-status required fields, error codes). That shows RoomCare follows the document; it does **not** prove the real FrontDesk matches it. Do the end-to-end test of document §12 together before treating this as operational.

## Decisions you must make

1. **When may FrontDesk release a room?** FrontDesk turns a room AVAILABLE as soon as it receives `COMPLETED`, and calls that "cleaned **and inspected**". RoomCare has a separate inspection step. By default (as originally specified) RoomCare sends `COMPLETED` when the housekeeper finishes (RoomCare "Room Clean"), i.e. **before** RoomCare's inspection. To release rooms only after inspection, set in `.env`:
   `PMS_NOTIFY_ON=inspection_passed` and `FRONTDESK_STATUS_WORDS={"Clean":null,"Inspected":"COMPLETED"}`.
2. **Is RoomCare "the Housekeeping System"?** (document §2). FrontDesk needs a yes/no from you; if no, they set up a separate client with its own key, secret and webhook target.

## Environment (`.env`)

| Variable | Value |
|---|---|
| `PMS_MODE` | `mock` (default: updates recorded, **not sent**; each shows the request that *would* be sent) · `live` · `disabled` |
| `FRONTDESK_API_BASE_URL` | `https://<frontdesk-host>/api/v1/integrations` **(host: ask FrontDesk)** |
| `FRONTDESK_API_TOKEN` | FrontDesk's `HOUSEKEEPING_API_KEY`, sent as `X-Api-Key` |
| `FRONTDESK_API_SIGNING_SECRET` | `HOUSEKEEPING_INBOUND_SECRET`: signs every POST |
| `FRONTDESK_WEBHOOK_SECRET` | `HOUSEKEEPING_WEBHOOK_SECRET`: verifies webhooks |
| `FRONTDESK_SYNC_INTERVAL_MINUTES` | automatic room sync; 0/unset = off |
| `FRONTDESK_API_TIMEOUT_MS`, `PMS_MAX_ATTEMPTS` | timeout (10 s) and delivery attempts (6) |
| `FRONTDESK_ROOM_MAP`, `FRONTDESK_CLEANING_STATUS_TEMPLATE`, `FRONTDESK_STATUS_WORDS`, `FRONTDESK_PATH_*`, `FRONTDESK_API_AUTH_HEADER/SCHEME` | optional overrides if FrontDesk changes the contract |

Keep all secrets in `.env` (git-ignored), never in the repository. Give FrontDesk your **webhook receiver URL**: `https://<roomcare-host>/api/frontdesk/webhook` (HTTPS in production).

## 1. Room synchronization (GET /housekeeping/rooms, /rooms/{room_number})

`npm run sync:frontdesk` (all) · `npm run sync:frontdesk -- 101` (one) · `FRONTDESK_SYNC_INTERVAL_MINUTES` · also triggered per room by `RoomStatusChanged` and when a `RoomVacated` names a room RoomCare does not have yet.

| FrontDesk (§7) | RoomCare |
|---|---|
| `room_id` | `Rooms.externalId` (the permanent id — the document says `room_number` "can change", so a renumbered room is followed) |
| `room_number` | `roomNo` (also the fallback key: a hand-made room with the same number is **linked**, not duplicated) |
| `room_type`, `floor` (text → whole number) | `type`, `floor` |
| `status` | occupancy: `OCCUPIED` = Occupied; `AVAILABLE` `RESERVED` `DIRTY` `CLEANING` = Vacant; `MAINTENANCE` = ignored |
| `status_changed_at` | time of the status change |
| `open_task`, `last_cleaned_at` | not used |

- Missing rooms are created; changed type/floor/number updated; no duplicates. A **new** room starts Dirty if FrontDesk says `DIRTY`/`CLEANING`, else Clean.
- **RoomCare's housekeeping status is never overwritten** for an existing room.
- A bad record never stops the rest. Each run is stored in `integration_events` (`RoomSync`: counts, errors) and the system log; `Rooms.externalSyncedAt` is the per-room sync time. CLI exit code: 0 ok · 1 failed · 2 finished with room errors.

## 2. Cleaning status (POST /housekeeping/cleaning-status)

Signed per §4.4 (`X-Timestamp`, `X-Signature = sha256=HMAC(secret, ts + "." + body)`), with an `Idempotency-Key` that stays the same on every retry of an update.

| RoomCare | FrontDesk `status` | Sent when | Body |
|---|---|---|---|
| Room Dirty | `PENDING` | a cleaning task exists for the vacated room (once per task) | `status, external_task_id, room_number, [event_id], [assigned_to]` |
| Cleaning | `IN_PROGRESS` | housekeeper taps Start | `+ started_by, started_at` |
| Room Clean | `COMPLETED` | housekeeper completes (see decision 1) | `+ completed_by, completed_at` |
| Vacant Room (inspected) | not sent by default | — | — |

- `external_task_id` = RoomCare task code (e.g. `CT-2026-1121-001`); employee id = staff code (fallback `USER-<id>`); `event_id` = the FrontDesk `RoomVacated` id when the task came from its webhook; rooms identified by `room_number`.
- Nothing is sent for a room without a task (FrontDesk keys work on `external_task_id`).
- **Retries (§9.3):** network errors, timeouts, 408/425/429, 5xx and `409 REQUEST_IN_PROGRESS` are retried with back-off. Any other 4xx is **not** retried: the event goes to FAILED, admins are alerted, and it can be retried from the Integrations page after the cause is fixed. `409 DUPLICATE_TASK / TASK_ALREADY_STARTED / DUPLICATE_CLEANING_COMPLETION` count as delivered ("treat as done"). `429 Retry-After` is not read; the normal back-off applies.
- Delivery never blocks or fails the housekeeper's action. Updates can arrive out of order after retries; FrontDesk accepts skipped steps and answers "treat as done" for late ones.
- RoomCare never changes guest occupancy.

## 3. Check-out detection

FrontDesk's `RoomVacated` webhook is the primary trigger (**confirmed in the document**): room → Dirty, **one** cleaning task (repeat event_id or an already-open task creates no second one), admins notified, PENDING sent back, and the task id returned in the webhook response. The room sync is a fallback: **OCCUPIED → not occupied** while RoomCare has the room Occupied is a confirmed check-out and does the same. A vacant room that was never occupied in RoomCare is never made Dirty.

`RoomCleaned` with `origin: "FRONT_DESK"` (desk marked it clean without RoomCare): RoomCare logs it and alerts admins to review the still-open task. It does **not** close the task by itself (RoomCare has no "cancelled" task state); decide if you want that.

## 4. Status model

Occupancy (FrontDesk's) and housekeeping (RoomCare's) stay separate; RoomCare derives both from `Rooms.status`; `Rooms.pmsStatus` holds FrontDesk's last occupancy.

## 5. Database

No change. Uses `integration_events` (new types `RoomSync`, `CleaningStatusChanged`, FrontDesk webhook events) and the existing `Rooms.externalId / externalSyncedAt / pmsStatus`.

## 6. StaffPay

Unchanged: RoomCare's own `/api/integrations/staffpay/*` (job logs, task history, work duration, overtime (empty), performance). No StaffPay structure assumed.

## Examples (from the document)

```
POST /api/v1/integrations/housekeeping/cleaning-status
X-Api-Key: <key>   Idempotency-Key: <stable per update>   X-Timestamp: 1796295660   X-Signature: sha256=<hex>
{ "status": "PENDING", "external_task_id": "CT-2026-1203-001", "room_number": "204", "event_id": "EVT-000010" }
{ "status": "IN_PROGRESS", "external_task_id": "CT-2026-1203-001", "room_number": "204", "started_by": "HK-001", "started_at": "2026-12-03T11:10:00.000Z" }
{ "status": "COMPLETED", "external_task_id": "CT-2026-1203-001", "room_number": "204", "completed_by": "HK-001", "completed_at": "2026-12-03T11:40:00.000Z" }
```
Webhook response RoomCare returns: `{ "received": true, "duplicate": false, "task_id": "CT-2026-1203-001" }`.

## Testing results

`npm test`: **24 passed** (11 existing API tests + 13 FrontDesk tests, all against the document-following stub). Covered: nothing sent/synced when unconfigured; rooms created from the §7 shape (text floor, `room_id` as id, MAINTENANCE ignored); no duplicates on repeat; details updated without touching housekeeping status; hand-made room linked; renumbered room followed; check-out → one Dirty task + PENDING; IN_PROGRESS/COMPLETED required fields and valid signatures; idempotent replay; "already recorded" = delivered; a 4xx fails immediately and alerts; a 5xx retries then succeeds; webhook signature/timestamp verification, unknown room auto-created, duplicate delivery ignored, `event_id` linked; RoomStatusChanged refresh; RoomCleaned from the desk alerts once.

## Still open

**From FrontDesk:** the real host (test and production), the API key, inbound signing secret and webhook secret; a test room for §12; the answer to whether `COMPLETED` should wait for inspection (decision 1) and to what `RoomCleaned origin FRONT_DESK` should do to RoomCare's task.
**For FrontDesk (their §10, room sync *to* RoomCare):** RoomCare already has `POST/PUT/GET /api/integrations/frontdesk/rooms[/{externalRoomId}]` (API-key auth, `Idempotency-Key`/`eventId` honoured, lookup by external id, see `docs/integration-api.md`) with its own field names and **no deactivate operation**; whether to adopt those or define new ones is yours to confirm before FrontDesk connects. RoomCare's room list to link (R7) can be exported from the Rooms page.
