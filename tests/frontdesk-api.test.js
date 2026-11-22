// Tests for the FrontDesk integration, following "Connecting RoomCare to the FrontDesk" (ROOM_SYNC.pdf, 2026-11-21).
// Run with: npm test
//
// IMPORTANT: this is NOT a test against the real FrontDesk. No real FrontDesk host or credentials have been available. These
// tests run RoomCare against a local STUB that implements the document's contract (response envelope, X-Api-Key, signed POSTs,
// Idempotency-Key replay, required fields per status, error codes), so they show RoomCare follows the document, not that the
// real FrontDesk behaves as documented. RoomCare runs with its built-in defaults (no mapping overrides). Own DB: RoomCare_test_fdf.
import http from "http";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import path from "path";

const API_KEY = "stub-api-key", SIGNING_SECRET = "stub-signing-secret", WEBHOOK_SECRET = "stub-webhook-secret";
const sign = (secret, ts, raw) => "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");

// ── Stub FrontDesk, behaving as the document describes ───────────────────────────────────────────────
const stub = { rooms: [], posts: [], gets: [], next: null, idem: new Map(), tasks: new Map() };
const stubServer = http.createServer((req, res) => {
  const reply = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const fail = (code, errCode, message, details) => reply(code, { success: false, error: { code: errCode, message, ...(details ? { details } : {}) } });
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if ((req.headers["x-api-key"] || "") !== API_KEY) return fail(401, "INVALID_API_KEY", "Missing or wrong API key");
    if (req.method === "GET") {
      stub.gets.push(req.url);
      if (req.url === "/housekeeping/rooms") return reply(200, { success: true, data: stub.rooms });
      const one = req.url.match(/^\/housekeeping\/rooms\/([^/]+)$/);
      if (one) {
        const r = stub.rooms.find((x) => x.room_number === decodeURIComponent(one[1]));
        return r ? reply(200, { success: true, data: r }) : fail(404, "ROOM_NOT_FOUND", "Room not found");
      }
      return fail(404, "NOT_FOUND", "No such endpoint");
    }
    if (req.method !== "POST" || req.url !== "/housekeeping/cleaning-status") return fail(404, "NOT_FOUND", "No such endpoint");

    // §4.3/4.4: Idempotency-Key, X-Timestamp, X-Signature
    const key = req.headers["idempotency-key"], ts = req.headers["x-timestamp"], sig = req.headers["x-signature"];
    if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) return fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key missing or malformed");
    if (!ts || !sig) return fail(401, "SIGNATURE_REQUIRED", "Signature required");
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return fail(401, "SIGNATURE_EXPIRED", "Timestamp too far off");
    if (sig !== sign(SIGNING_SECRET, ts, raw)) return fail(401, "INVALID_SIGNATURE", "Invalid signature");
    if (stub.next) { const n = stub.next; return fail(n.status, n.code, n.message || n.code); }

    // §4.5 idempotency
    if (stub.idem.has(key)) {
      const prior = stub.idem.get(key);
      if (prior.raw !== raw) return fail(422, "IDEMPOTENCY_KEY_REUSED", "Same key, different body");
      return reply(prior.code, prior.body, { "Idempotent-Replayed": "true" });
    }
    // §6.2 validation
    const b = JSON.parse(raw);
    const errors = {};
    if (!["PENDING", "IN_PROGRESS", "COMPLETED"].includes(String(b.status).toUpperCase())) errors.status = "must be PENDING, IN_PROGRESS or COMPLETED";
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(b.external_task_id || "")) errors.external_task_id = "required";
    if (!b.room_id && !b.room_number) errors.room_number = "room_id or room_number is required";
    if (b.event_id && String(b.event_id).length > 30) errors.event_id = "up to 30 characters";
    if (b.status === "IN_PROGRESS" && !b.started_by) errors.started_by = "required for IN_PROGRESS";
    if (b.status === "COMPLETED" && !b.completed_by) errors.completed_by = "required for COMPLETED";
    if (b.status === "COMPLETED" && !b.completed_at) errors.completed_at = "required for COMPLETED";
    if (Object.keys(errors).length) return fail(422, "VALIDATION_ERROR", "Validation failed", errors);
    const room = stub.rooms.find((r) => r.room_number === b.room_number);
    if (!room) return fail(404, "ROOM_NOT_FOUND", "Room not found");
    // task state machine
    const state = stub.tasks.get(b.external_task_id);
    if (b.status === "PENDING" && state) return fail(409, "DUPLICATE_TASK", "Task already registered");
    if (b.status === "IN_PROGRESS" && (state === "IN_PROGRESS" || state === "COMPLETED")) return fail(409, "TASK_ALREADY_STARTED", "Task already in progress or completed");
    stub.tasks.set(b.external_task_id, b.status);
    const body = { success: true, data: { external_task_id: b.external_task_id, task_status: b.status, room_number: b.room_number } };
    stub.idem.set(key, { raw, code: 200, body });
    stub.posts.push({ headers: req.headers, body: b });
    reply(200, body);
  });
});
await new Promise((r) => stubServer.listen(0, r));

process.env.DB_NAME = "RoomCare_test_fdf";
process.env.NODE_ENV = "test";
process.env.PMS_MODE = "live";
process.env.FRONTDESK_API_BASE_URL = `http://localhost:${stubServer.address().port}`;
process.env.FRONTDESK_API_TOKEN = API_KEY;
process.env.FRONTDESK_API_SIGNING_SECRET = SIGNING_SECRET;
process.env.FRONTDESK_WEBHOOK_SECRET = WEBHOOK_SECRET;

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection({ host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || "root", password: process.env.DB_PASS || "" });
await conn.query("CREATE DATABASE IF NOT EXISTS RoomCare_test_fdf");
await conn.end();

const { default: app } = await import("../index.js");
const m = await import("../models/index.js");
const { startTask, completeTask } = await import("../services/taskService.js");
const { syncAllRooms, syncOneRoom } = await import("../services/frontdeskSyncService.js");
const { queueCleaningStatus, retryEvent } = await import("../services/pmsIntegrationService.js");
const { postCleaningStatus } = await import("../services/frontdeskApiClient.js");
const { mappingProblems, buildCleaningStatusRequest } = await import("../config/frontdeskApiMapping.js");
const { sequelize, User, Room, CleaningTask, IntegrationEvent, SystemLog } = m;

let hk, admin, server, base;
const waitFor = async (fn) => {
  for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return null;
};
// A room exactly as the document's §7 shows it.
const fdRoom = (n, extra = {}) => ({
  room_id: Number(n), room_number: String(n), room_type: "Deluxe", floor: String(Math.floor(n / 100)), status: "AVAILABLE",
  status_changed_at: "2026-12-03T11:00:00.000Z", last_cleaned_at: "2026-12-01T09:15:00.000Z", open_task: null, ...extra,
});
const byNo = (n) => Room.findOne({ where: { roomNo: String(n) } });
const postsFor = (n) => stub.posts.filter((p) => p.body.room_number === String(n));

// A webhook exactly as the document's §5 describes it.
const webhook = async (event, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/frontdesk/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PMS-Event": event.event, "X-PMS-Event-Id": event.event_id, "X-PMS-Timestamp": String(ts), "X-PMS-Signature": sign(secret, ts, raw) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  await sequelize.sync({ force: true });
  hk = await User.create({ name: "Hana Housekeeper", email: "hk@test.local", password: "x", role: "housekeeper", staffCode: "HK-001" });
  admin = await User.create({ name: "Ada Admin", email: "admin@test.local", password: "x", role: "admin" });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server?.close(); stubServer.close(); await sequelize.close(); });

test("not configured: nothing is guessed, nothing is created, the reason is recorded", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const run = promisify(execFile)(process.execPath, ["sync-frontdesk.js"], { cwd: root, env: { ...process.env, FRONTDESK_API_BASE_URL: "", FRONTDESK_API_TOKEN: "" } });
  const err = await run.then(() => null, (e) => e);
  assert.ok(err, "CLI must fail");
  assert.equal(err.code, 1);
  assert.match(err.stderr, /FRONTDESK_API_BASE_URL is not set/);
  assert.match(err.stderr, /FRONTDESK_API_TOKEN/);
  assert.equal(await Room.count(), 0);
  const ev = await IntegrationEvent.findOne({ where: { eventType: "RoomSync" } });
  assert.equal(ev.status, "REJECTED");
  await ev.destroy();
  assert.deepEqual(mappingProblems(), [], "the built-in mapping follows the document");
  assert.match(mappingProblems(null)[0], /not set/);
});

test("room sync: creates missing rooms from the documented response, no manual entry needed", async () => {
  stub.rooms = [fdRoom(101), fdRoom(102, { status: "OCCUPIED" }), fdRoom(103, { status: "DIRTY" }), fdRoom(104, { status: "MAINTENANCE" })];
  const s = await syncAllRooms();
  assert.deepEqual([s.counts.fetched, s.counts.created, s.counts.errors], [4, 4, 0]);
  assert.deepEqual(s.warnings, [], "MAINTENANCE is expected, not a warning");
  const r101 = await byNo(101);
  assert.equal(r101.type, "Deluxe");
  assert.equal(r101.floor, 1, 'FrontDesk\'s floor is text ("1") — stored as a number');
  assert.equal(r101.externalId, "101", "room_id is the external id");
  assert.equal(r101.status, "VACANT_CLEAN");
  assert.ok(r101.externalSyncedAt);
  assert.equal((await byNo(102)).status, "OCCUPIED");
  assert.equal((await byNo(103)).status, "VACANT_DIRTY", "a room FrontDesk reports DIRTY starts Dirty");
  assert.equal(await CleaningTask.count(), 0, "syncing never creates cleaning tasks on its own");
  assert.ok(stub.gets.includes("/housekeeping/rooms"));
  const ev = await IntegrationEvent.findOne({ where: { eventType: "RoomSync" }, order: [["id", "DESC"]] });
  assert.equal(ev.status, "PROCESSED");
});

test("room sync: repeating it creates no duplicates", async () => {
  const s = await syncAllRooms();
  assert.deepEqual([s.counts.created, s.counts.updated, s.counts.unchanged], [0, 0, 4]);
  assert.equal(await Room.count(), 4);
});

test("room sync: updates details, never the housekeeping status, links hand-made rooms, follows a renumbered room", async () => {
  await (await byNo(101)).update({ status: "CLEANING" });
  await Room.create({ roomNo: "105", type: "Old type", floor: 1, status: "VACANT_DIRTY" }); // entered by hand before
  stub.rooms = [fdRoom(101, { room_type: "Suite", floor: "2" }), fdRoom(102, { status: "OCCUPIED" }), fdRoom(103, { status: "DIRTY" }), fdRoom(104, { status: "MAINTENANCE" }), fdRoom(105)];
  const s = await syncAllRooms();
  assert.equal(s.counts.updated, 1);
  assert.equal(s.counts.linked, 1);
  const r101 = await byNo(101);
  assert.deepEqual([r101.type, r101.floor], ["Suite", 2]);
  assert.equal(r101.status, "CLEANING", "housekeeping status untouched");
  const r105 = await byNo(105);
  assert.deepEqual([r105.externalId, r105.type, r105.status], ["105", "Deluxe", "VACANT_DIRTY"]);
  assert.equal(await Room.count({ where: { roomNo: "105" } }), 1);
  await r101.update({ status: "VACANT_CLEAN" });

  stub.rooms[1] = fdRoom(102, { status: "OCCUPIED", room_id: 102, room_number: "112" }); // room_number can change, room_id cannot
  const renum = await syncAllRooms();
  assert.equal(renum.counts.updated, 1);
  assert.equal(await Room.count({ where: { roomNo: "112" } }), 1);
  assert.equal(await Room.count({ where: { roomNo: "102" } }), 0);
  stub.rooms[1] = fdRoom(102, { status: "OCCUPIED" });
  await syncAllRooms();
  assert.equal(await Room.count(), 5);
});

test("checkout detection: OCCUPIED -> DIRTY makes the room Dirty with ONE task and sends PENDING; other rooms untouched", async () => {
  stub.rooms = stub.rooms.map((r) => (r.room_number === "102" ? fdRoom(102, { status: "DIRTY" }) : r));
  const s = await syncAllRooms();
  assert.equal(s.counts.checkouts, 1);
  const r102 = await byNo(102);
  assert.equal(r102.status, "VACANT_DIRTY");
  const task = await CleaningTask.findOne({ where: { roomId: r102.id } });
  assert.equal(await CleaningTask.count(), 1, "only the checked-out room got a task (103 and 105 were already dirty/vacant)");
  assert.equal(task.source, "PMS");
  assert.equal((await syncAllRooms()).counts.checkouts, 0);
  assert.equal(await CleaningTask.count(), 1);

  const pending = await waitFor(() => postsFor(102)[0]);
  assert.ok(pending, "PENDING sent");
  assert.deepEqual(pending.body, { status: "PENDING", external_task_id: task.code, room_number: "102" }, "documented fields only; event_id and assigned_to left out when unknown");
  assert.equal(pending.headers["x-api-key"], API_KEY);
});

test("status push: IN_PROGRESS and COMPLETED carry the required fields, signed", async () => {
  const r102 = await byNo(102);
  const task = await CleaningTask.findOne({ where: { roomId: r102.id } });
  await task.update({ housekeeperId: hk.id, adminId: admin.id, assignedAt: new Date() });
  await startTask(task.id, hk);
  const started = await waitFor(() => postsFor(102).find((p) => p.body.status === "IN_PROGRESS"));
  assert.ok(started);
  assert.equal(started.body.started_by, "HK-001");
  assert.ok(!Number.isNaN(Date.parse(started.body.started_at)));

  await completeTask(task.id, hk, "done");
  const done = await waitFor(() => postsFor(102).find((p) => p.body.status === "COMPLETED"));
  assert.ok(done);
  assert.equal(done.body.completed_by, "HK-001");
  assert.ok(Date.parse(done.body.completed_at) >= Date.parse(started.body.started_at));
  assert.deepEqual(postsFor(102).map((p) => p.body.status), ["PENDING", "IN_PROGRESS", "COMPLETED"]);
  for (const p of postsFor(102)) {
    assert.match(p.headers["idempotency-key"], /^[A-Za-z0-9._:-]{8,100}$/);
    assert.equal(p.headers["x-signature"], sign(SIGNING_SECRET, p.headers["x-timestamp"], JSON.stringify(p.body)), "signature covers the exact body sent");
  }
  assert.equal((await byNo(102)).status, "VACANT_CLEAN");
  assert.equal((await byNo(102)).pmsStatus, "VACANT", "RoomCare did not change guest occupancy");
});

test("idempotency: the same key and body again is replayed, not applied twice", async () => {
  const body = { status: "PENDING", external_task_id: "RC-IDEM-1", room_number: "104" };
  const first = await postCleaningStatus(body, "roomcare-RC-IDEM-1-PENDING");
  const again = await postCleaningStatus(body, "roomcare-RC-IDEM-1-PENDING");
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(stub.posts.filter((p) => p.body.external_task_id === "RC-IDEM-1").length, 1);
  await assert.rejects(() => postCleaningStatus({ ...body, remarks: "x" }, "roomcare-RC-IDEM-1-PENDING"), (e) => e.code === "IDEMPOTENCY_KEY_REUSED" && e.retryable === false);
});

test("errors: 'already recorded' counts as delivered, a wrong request fails at once, a server error is retried", async () => {
  const r103 = await byNo(103);
  const task = await CleaningTask.create({ code: "CT-TEST-0001", roomId: r103.id, housekeeperId: null, taskType: "CHECKOUT_CLEAN", title: "Checkout clean", priority: "MEDIUM", status: "PENDING", source: "MANUAL" });

  stub.next = { status: 409, code: "TASK_ALREADY_STARTED" };                       // §9.2: treat as done
  const dup = await queueCleaningStatus(r103, "In Progress");
  assert.equal(dup.status, "SENT");
  assert.match(dup.response, /ALREADY RECORDED \(TASK_ALREADY_STARTED\)/);

  stub.next = null;                                                                // nobody assigned -> no started_by -> 422
  const wrong = await queueCleaningStatus(r103, "In Progress");
  assert.equal(wrong.status, "FAILED", "a 4xx is not retried unchanged");
  assert.equal(wrong.attempts, 1);
  assert.match(wrong.lastError, /422 VALIDATION_ERROR/);
  assert.ok(await SystemLog.count({ where: { action: "PMS_EVENT_FAILED" } }));

  await task.update({ housekeeperId: hk.id });
  stub.next = { status: 500, code: "INTERNAL_ERROR" };                              // §9.3: retry 5xx
  const flaky = await queueCleaningStatus(r103, "In Progress");
  assert.equal(flaky.status, "PENDING");
  assert.ok(flaky.nextAttemptAt);
  assert.match(flaky.lastError, /HTTP 500/);
  stub.next = null;
  const retried = await retryEvent(flaky.id, admin);
  assert.equal(retried.status, "SENT");
  assert.equal(postsFor(103).filter((p) => p.body.status === "IN_PROGRESS").length, 1);
});

test("request mapping: unsupported statuses are skipped, a task id is required", () => {
  const ev = (status, task = { code: "CT-1" }) => ({ id: 1, eventId: "e", payload: { room: { roomNo: "1", housekeepingStatus: status }, task } });
  assert.match(buildCleaningStatusRequest(ev("Inspected")).skip, /Inspected/);
  assert.equal(buildCleaningStatusRequest(ev("Clean")).body.status, "COMPLETED");
  assert.throws(() => buildCleaningStatusRequest(ev("Dirty", null)), /task id/);
});

test("webhook: signature and timestamp are verified", async () => {
  const event = { event: "RoomVacated", event_id: "EVT-BAD", occurred_at: new Date().toISOString(), room_number: "101" };
  assert.equal((await webhook(event, { secret: "wrong-secret" })).status, 401);
  assert.equal((await webhook(event, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  const none = await fetch(`${base}/api/frontdesk/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
  assert.equal(none.status, 401);
  assert.equal(await IntegrationEvent.count({ where: { eventId: "EVT-BAD" } }), 0, "nothing recorded for an unverified request");
});

test("webhook RoomVacated: unknown room is created first, then Dirty + ONE task; duplicate delivery is ignored; PENDING links the event", async () => {
  stub.rooms.push(fdRoom(201, { status: "DIRTY" }));                               // FrontDesk has it, RoomCare does not
  const event = { event: "RoomVacated", event_id: "EVT-000010", occurred_at: new Date().toISOString(), room_id: 201, room_number: "201", reason: "CHECKOUT", room_status: "DIRTY", cleaning_status: "PENDING" };
  const r = await webhook(event);
  assert.equal(r.status, 200);
  assert.equal(r.body.received, true);
  const room = await byNo(201);
  assert.ok(room, "room created from FrontDesk");
  const task = await CleaningTask.findOne({ where: { roomId: room.id } });
  assert.equal(r.body.task_id, task.code, "task id returned for FrontDesk's console");
  assert.equal(room.status, "VACANT_DIRTY");
  assert.equal((await CleaningTask.count({ where: { roomId: room.id } })), 1);

  const dup = await webhook(event);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal((await CleaningTask.count({ where: { roomId: room.id } })), 1);

  const pending = await waitFor(() => postsFor(201).find((p) => p.body.status === "PENDING"));
  assert.ok(pending);
  assert.equal(pending.body.event_id, "EVT-000010", "the task answers this RoomVacated event");
  assert.equal(postsFor(201).length, 1);
});

test("webhook RoomStatusChanged refreshes the room; RoomCleaned from the front desk alerts the admins", async () => {
  stub.rooms = stub.rooms.map((r) => (r.room_number === "104" ? fdRoom(104, { room_type: "Penthouse", status: "MAINTENANCE" }) : r));
  const changed = await webhook({ event: "RoomStatusChanged", event_id: "EVT-000011", occurred_at: new Date().toISOString(), room_number: "104", from_status: "AVAILABLE", to_status: "MAINTENANCE" });
  assert.equal(changed.status, 200);
  assert.equal((await byNo(104)).type, "Penthouse");

  const cleaned = { event: "RoomCleaned", event_id: "EVT-000012", occurred_at: new Date().toISOString(), room_number: "201", room_status: "AVAILABLE", external_task_id: "x", origin: "FRONT_DESK" };
  assert.equal((await webhook(cleaned)).status, 200);
  assert.equal(await SystemLog.count({ where: { action: "FRONTDESK_MARKED_CLEAN" } }), 1);
  assert.equal((await webhook(cleaned)).body.duplicate, true);
  assert.equal(await SystemLog.count({ where: { action: "FRONTDESK_MARKED_CLEAN" } }), 1, "a repeat delivery does not alert twice");
  assert.equal((await webhook({ event: "SomethingNew", event_id: "EVT-000013" })).status, 200, "unknown events are acknowledged");
});

test("single room: GET /housekeeping/rooms/{room_number}; unknown room is a recorded ROOM_NOT_FOUND", async () => {
  stub.rooms = stub.rooms.map((r) => (r.room_number === "103" ? fdRoom(103, { room_type: "Studio", status: "DIRTY" }) : r));
  const r = await syncOneRoom("103");
  assert.equal(r.action, "updated");
  assert.equal((await byNo(103)).type, "Studio");
  assert.ok(stub.gets.includes("/housekeeping/rooms/103"));
  await assert.rejects(() => syncOneRoom("999"), (e) => e.status === 404 && /ROOM_NOT_FOUND/.test(e.message));
  await assert.rejects(() => syncOneRoom("bad room!"), (e) => e.status === 422);
});
