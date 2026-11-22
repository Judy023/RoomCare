# RoomCare Integration API

System-to-system API for **FrontDeskFlow** (front desk / PMS) and **StaffPay** (attendance / payroll).
Base path: `/api/integrations`. Run the tests with `npm test`.

## Implementation status

| Integration | Direction | Status |
|---|---|---|
| FrontDeskFlow → RoomCare: room sync, room update, checkout | inbound | **Implemented and tested** in RoomCare. Not yet connected to a real FrontDeskFlow. |
| RoomCare → FrontDeskFlow: `room-status-updates`, `cleaned-rooms` (FrontDeskFlow reads) | outbound, pull | **Implemented and tested.** |
| RoomCare → FrontDeskFlow: push of housekeeping status (Dirty, In Progress, Clean, Inspected) | outbound, push | **Implemented against FrontDeskFlow's `POST /housekeeping/cleaning-status`, not connected.** Runs in `mock` mode: events are queued and marked sent (mock), nothing leaves the server. Needs the real base URL, auth and request body. See `docs/frontdeskflow-api.md`. |
| FrontDeskFlow → RoomCare: room sync via `GET /housekeeping/rooms` and `/rooms/{roomNumber}` | RoomCare pulls | **Implemented, not connected.** Needs the real base URL, auth and response format. See `docs/frontdeskflow-api.md`. |
| StaffPay → RoomCare: job logs, work hours, performance | inbound, pull | **Implemented and tested.** Not yet connected to a real StaffPay. |
| StaffPay: overtime | inbound, pull | Endpoint exists but always returns an empty list: RoomCare does not record overtime. |

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `FRONTDESK_API_KEY` | Key FrontDeskFlow sends. Falls back to `PMS_WEBHOOK_TOKEN`. |
| `STAFFPAY_API_KEY` | Key StaffPay sends. Falls back to `HR_API_TOKEN`. **Must differ** from the FrontDeskFlow key (otherwise every call returns 503). |
| `PMS_MODE` | `mock` (default) / `live` / `disabled`. `disabled` makes all FrontDeskFlow endpoints return 503. |
| `PMS_OUTBOUND_URL` | Where RoomCare pushes `CleaningCompleted` in `live` mode. **Empty until FrontDeskFlow provides it.** |
| `PMS_OUTBOUND_TOKEN`, `PMS_OUTBOUND_AUTH_HEADER`, `PMS_OUTBOUND_AUTH_SCHEME`, `PMS_OUTBOUND_METHOD` | How the push is authenticated and sent (defaults: `Authorization: Bearer <token>`, `POST`). |
| `PMS_SIGNING_SECRET` | Optional HMAC-SHA256 of the body in `X-RoomCare-Signature`. |
| `PMS_NOTIFY_ON` | `task_completed` (default) or `inspection_passed`: when the push is queued. |

Generate keys with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Without `FRONTDESK_API_KEY` in production the endpoints return 503; a development fallback token is used outside production only.
When FrontDeskFlow publishes its API, set the variables above and edit `config/frontdeskMapping.js` (payload shape). The logic that decides *when* to notify does not change.

Database: run `npm run migrate:integrations` once (adds `Rooms.externalId` [unique], `Rooms.description`, `Rooms.externalSyncedAt`; the rest already existed). `npm run migrate:integrations -- --revert` backs up and removes them.

## Common rules

**Headers (all endpoints):** `Authorization: Bearer <key>` or `X-API-Key: <key>`; `Content-Type: application/json` for bodies. Optional `Idempotency-Key` (see below).

**Response envelope**
```json
{ "success": true, "data": { }, "meta": { } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [ { "field": "floor", "message": "must be a whole number from 0 to 200" } ] } }
```

**Status codes:** 200 OK · 201 Created · 400 malformed JSON · 401 missing/invalid key · 403 key belongs to the other system · 404 not found · 409 conflict · 422 validation failed · 503 integration disabled or not configured · 500 unexpected error.

**Statuses are separate**
- `housekeepingStatus` (owned by RoomCare): `Dirty`, `In Progress`, `Clean`, `Inspected` (`null` while occupied / out of order).
- `occupancyStatus` (owned by FrontDeskFlow): `Occupied`, `Vacant`.
Completing a cleaning never changes occupancy. RoomCare only reports that housekeeping is done.

**Idempotency:** room sync is idempotent by `externalRoomId`. Checkout requires an `eventId` (body, or the `Idempotency-Key` header): repeating an `eventId` returns `duplicate: true` and changes nothing. A new `eventId` for a room that already has an open cleaning task reuses that task.

**Logging:** every request is written to System Logs (method, path, status, duration, IP; never bodies or keys).

---

## FrontDeskFlow → RoomCare

Auth: FrontDeskFlow key. Room fields:

| Field | Rules |
|---|---|
| `externalRoomId` | required on POST; 1–100 chars `A-Z a-z 0-9 . _ : - /` |
| `roomNumber` | required on POST; 1–20 chars `A-Z a-z 0-9 -`; unique |
| `roomType` (or `type`) | required on POST; 1–100 chars (any text) |
| `floor` | required on POST; integer 0–200 |
| `description` | optional; text ≤ 2000 |
| `roomStatus` (or `occupancyStatus`, `status`) | optional; `Occupied` or `Vacant` |
| `housekeepingStatus` | POST only, optional: `Dirty`/`Clean`/`Inspected`. Default `Clean`. Ignored on PUT (RoomCare owns it). |
| `eventId` | optional idempotency key (or `Idempotency-Key` header) |

### POST `/api/integrations/frontdesk/rooms`
Creates a room. If `externalRoomId` already exists → 200, `created:false`, nothing changed. If a room with the same number was entered manually in RoomCare (no external id) it is **linked** (`linked:true`), not duplicated. Same number but a different external id → 409.
```json
{ "externalRoomId": "FDF-101", "roomNumber": "101", "roomType": "Deluxe King", "floor": 1, "description": "Garden view", "roomStatus": "Vacant" }
```
```json
{ "success": true, "created": true, "linked": false, "duplicate": false,
  "data": { "externalRoomId": "FDF-101", "roomCareRoomId": 12, "roomNumber": "101", "roomType": "Deluxe King", "floor": 1,
            "description": "Garden view", "housekeepingStatus": "Clean", "occupancyStatus": "Vacant", "outOfOrder": false,
            "openCleaningTask": null, "lastSyncedAt": "2026-11-21T03:37:51.000Z", "updatedAt": "2026-11-21T03:37:51.000Z" } }
```
Codes: 201, 200 (existing), 401, 403, 409, 422, 503.

### PUT `/api/integrations/frontdesk/rooms/{externalRoomId}`
Partial update; send only changed fields (at least one). `roomStatus: "Occupied"` marks the room occupied (409 while it is being cleaned). `roomStatus: "Vacant"` on a room RoomCare has as occupied → 409: send a checkout event instead, so housekeeping is triggered.
```json
{ "roomType": "Junior Suite", "floor": 2, "description": "Renovated" }
```
Response: `data` as above, plus `ignoredFields: ["housekeepingStatus"]` if that was sent. Codes: 200, 404 (not synchronized), 409, 422.

### POST `/api/integrations/frontdesk/checkout`
Guest checked out. Room becomes **Dirty** (`VACANT_DIRTY`), one unassigned cleaning task is created (source `PMS`) and admins are notified on the dashboard to assign a housekeeper.
| Field | Rules |
|---|---|
| `eventId` | required (or `Idempotency-Key`); 1–100 chars `A-Za-z0-9._:-` |
| `externalRoomId` or `roomNumber` | one required; must match if both sent |
| `occurredAt` | optional ISO-8601, not in the future (default: now) |
```json
{ "eventId": "co-20261121-0001", "externalRoomId": "FDF-101", "occurredAt": "2026-11-21T03:30:00Z" }
```
```json
{ "success": true, "data": { "eventId": "co-20261121-0001", "duplicate": false, "taskCreated": true,
  "task": { "taskCode": "CT-2026-1121-001", "status": "PENDING" },
  "room": { "externalRoomId": "FDF-101", "roomNumber": "101", "housekeepingStatus": "Dirty", "occupancyStatus": "Vacant" } } }
```
Codes: 201 (task created), 200 (duplicate event, or existing task reused), 404, 422.
A room already being cleaned keeps its status. An occupied/clean/inspected room becomes Dirty.

### GET `/api/integrations/frontdesk/rooms/{externalRoomId}`
Returns the room (with `openCleaningTask`). Codes: 200, 404.

### GET `/api/integrations/frontdesk/rooms`
Query: `housekeeping_status` (Dirty|In Progress|Clean|Inspected), `occupancy_status` (Occupied|Vacant), `floor`, `updated_since` (ISO), `limit` (1–200, default 50), `offset`. Only synchronized rooms. Response: `data: [room…]`, `meta: { total, limit, offset }`. Codes: 200, 422.

---

## RoomCare → FrontDeskFlow

### GET `/api/integrations/frontdesk/room-status-updates`
The notifications RoomCare has prepared, oldest first, so FrontDeskFlow can poll without missing any: `CleaningCompleted` when cleaning finishes (Clean / Inspected) and `CleaningStatusChanged` for Dirty and In Progress. Read `payload.room.housekeepingStatus` for the status.
Query: `after_id` (cursor; pass `meta.nextCursor` from the last call), `since` (ISO), `delivery_status` (PENDING|SENDING|SENT|FAILED), `limit` (≤200).
```json
{ "success": true, "data": [ { "updateId": 7, "eventId": "roomcare-cc-5-1795232000000", "eventType": "CleaningCompleted",
  "occurredAt": "2026-11-21T04:10:00.000Z",
  "delivery": { "status": "SENT", "attempts": 1, "deliveredAt": "2026-11-21T04:10:00.000Z", "lastError": null, "mode": "mock" },
  "payload": { "room": { "roomNo": "101", "roomCareId": 12, "externalRoomId": "FDF-101", "housekeepingStatus": "Clean" },
               "task": { "code": "CT-2026-1121-001", "type": "CHECKOUT_CLEAN", "completedAt": "2026-11-21T04:09:58.000Z", "housekeeper": { "staffCode": "HK-001", "name": "Hana Housekeeper" } },
               "verification": "PENDING", "relatedEventId": "co-20261121-0001" } } ],
  "meta": { "limit": 50, "nextCursor": 7, "hasMore": false } }
```
`delivery.mode: "mock"` means the push side is not connected; the record is still available here. Codes: 200, 422.

### GET `/api/integrations/frontdesk/cleaned-rooms`
Rooms currently `Clean` or `Inspected`, with the task that cleaned them. Query: `since` (ISO, task completion), `housekeeping_status` (Clean|Inspected), `limit`, `offset`. Items are room objects plus `cleaningCompletedAt`, `verifiedAt`, `taskCode`, `completedBy`. A cleaned room is **not** declared available: FrontDeskFlow confirms nobody is assigned. Codes: 200, 422.

---

## StaffPay → RoomCare

Auth: StaffPay key. RoomCare returns records only; it calculates no salary, deductions, attendance or overtime. Returned employee data: `employeeId`, name, role only (no email, phone, password).

**Employee id:** `employeeId` is the employee's RoomCare `staffCode` (falls back to the RoomCare user id if no code is set). Both `staffCode` and numeric user id are accepted in requests. **Mapping to StaffPay's own employee ids is still to be agreed.**

**Common query parameters**
| Parameter | Rules |
|---|---|
| `employee_id` | staff code or RoomCare user id; 404 if unknown (housekeepers and technicians only) |
| `start_date`, `end_date` | `YYYY-MM-DD`, server local time, inclusive, by completion date. Default: last 7 days. Max range 93 days. |
| `task_status` | `completed` (default), or `DONE`, `INSPECTED` (cleaning), `RESOLVED`, `CLOSED` (maintenance) |
| `room_id` | RoomCare room id (number) |
| `task_type` | `Cleaning`, `Maintenance`, or a cleaning subtype: `CHECKOUT_CLEAN`, `STAYOVER`, `TOUCH_UP`, `DEEP_CLEAN` |
| `limit`, `offset` | job-logs / work-hours: limit 1–500 (default 100) |

### GET `/api/integrations/staffpay/job-logs`
### GET `/api/integrations/staffpay/employees/{employeeId}/job-logs`
Completed cleaning tasks (from housekeepers) and resolved maintenance work orders (from technicians).
```json
{ "success": true, "data": [ {
  "jobLogId": "CT-2026-1121-001",
  "employee": { "employeeId": "HK-001", "roomCareUserId": 4, "name": "Hana Housekeeper", "role": "housekeeper" },
  "task": { "taskId": 5, "type": "Cleaning", "subType": "CHECKOUT_CLEAN", "description": "Checkout clean", "priority": "MEDIUM" },
  "room": { "roomId": 12, "externalRoomId": "FDF-101", "roomNumber": "101" },
  "assignedAt": "2026-11-21T03:35:00.000Z", "startedAt": "2026-11-21T03:40:00.000Z", "completedAt": "2026-11-21T04:09:58.000Z",
  "durationMinutes": 30, "status": "INSPECTED",
  "verification": { "inspector": "Ada Admin", "result": "PASS", "inspectedAt": "2026-11-21T04:20:00.000Z", "checklistPassed": 6, "checklistTotal": 6, "qualityScore": 100 },
  "remarks": "Housekeeper: all done" } ],
  "meta": { "startDate": "2026-11-15", "endDate": "2026-11-21", "total": 1, "limit": 100, "offset": 0 } }
```
`verification` is `null` when not inspected (always for maintenance). Maintenance rows have `type: "Maintenance"`, `subType` = work-order category, `remarks` = resolution notes. Codes: 200, 401, 403, 404, 422.

### GET `/api/integrations/staffpay/work-hours`
Per-job durations (`startedAt` → `completedAt`) plus `summary` per employee (`jobsCompleted`, `jobsWithDuration`, `recordedMinutes`, `recordedHours`, `daysWithRecordedJobs`) over the whole filtered range. Includes a `disclaimer`: this is **task time, not attendance or payable hours**.

### GET `/api/integrations/staffpay/overtime`
Always `data: []`, `meta.tracked: false`. RoomCare has no overtime recording or approval, so nothing is invented. If overtime recording is added later, only verified records will be returned.

### GET `/api/integrations/staffpay/performance`
Per employee: `completedJobs`, `cleaningJobs`, `maintenanceJobs`, `averageJobMinutes`, `completedOnTime`/`completedLate` (tasks with a due time), `inspections { inspected, passed, failed, notInspected, averageQualityScore }`. RoomCare has no numeric rating; quality is the inspection result and checklist percentage.

---

## Still needed from the other developers

**FrontDeskFlow**
1. Base URL, endpoint(s) and HTTP method for receiving RoomCare's room-ready notification (or confirmation they will poll `room-status-updates`).
2. Authentication they require for calls into their API (header name, scheme, token issuing) and whether they want request signing.
3. Their exact payload format and status vocabulary (to fill in `config/frontdeskMapping.js`), and the retry/idempotency header they honour.
4. Their room-id format, and whether room create/update events carry an event id.
5. Whether a checkout event has a unique id RoomCare can use as `eventId`.
6. Confirmation that rooms they send use room types beyond RoomCare's four standard ones (RoomCare accepts any text).

**StaffPay**
1. How StaffPay identifies employees, and the mapping to RoomCare `staffCode` (or the id they want returned).
2. Whether they prefer pull (current), or push to a URL they provide, plus their auth method.
3. Whether they need an acknowledgement call. RoomCare already has `/api/hr/job-logs?pending=1` and `/api/hr/job-logs/ack` for exactly-once export; say if the `/api/integrations/staffpay` endpoints should use it too.
4. What overtime data they expect from RoomCare, if any (RoomCare records none today), and the time zone for date filters.
