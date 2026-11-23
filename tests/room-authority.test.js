// FrontDeskFlow as the room authority: connection state, backend lock on room management, archive, no duplicates.
// Own database (RoomCare_test_rooms). Run with: npm test
process.env.DB_NAME = "RoomCare_test_rooms";
process.env.FRONTDESK_API_KEY = "test-frontdesk-key";
process.env.STAFFPAY_API_KEY = "test-staffpay-key";
process.env.PMS_MODE = "mock";
process.env.NODE_ENV = "test";
delete process.env.FRONTDESK_ROOM_AUTHORITY;
delete process.env.FRONTDESK_API_BASE_URL;
delete process.env.FRONTDESK_API_TOKEN;

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection({ host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || "root", password: process.env.DB_PASS || "" });
await conn.query("CREATE DATABASE IF NOT EXISTS RoomCare_test_rooms");
await conn.end();

const { default: app } = await import("../index.js");
const { sequelize, User, Room, CleaningTask, IntegrationEvent } = await import("../models/index.js");
const { createRoom, updateRoom, deleteRoom, listRooms, board } = await import("../services/roomService.js");
const { connectionState } = await import("../services/roomIntegrationService.js");
const { syncAllRooms } = await import("../services/frontdeskSyncService.js");

let server, base, root, admin;
const FD = { Authorization: "Bearer test-frontdesk-key", "Content-Type": "application/json" };
const call = async (method, path, body, headers = FD) => {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const fdRoom = (n, extra = {}) => ({ externalRoomId: `FDF-${n}`, roomNumber: String(n), roomType: "Deluxe King", floor: Math.floor(n / 100), ...extra });

before(async () => {
  await sequelize.sync({ force: true });
  admin = await User.create({ name: "Ada Admin", email: "admin@test.local", password: "x", role: "admin" });
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://localhost:${server.address().port}`;
  base = `${root}/api/integrations`;
});
after(async () => { server?.close(); await sequelize.close(); });

test("not connected: nothing synced, RoomCare still manages rooms (dev/testing)", async () => {
  const s = await connectionState();
  assert.equal(s.state, "NOT_CONNECTED");
  assert.equal(s.locked, false);
  const room = await createRoom({ roomNo: "900", type: "Standard Twin", floor: 9 }, admin.id);
  assert.ok(!room.externalId);
  await updateRoom(room.id, { type: "Deluxe King", floor: 9 }, admin.id);
  await deleteRoom(room.id, admin.id);
});

test("an unconfigured pull sync fails without pretending to be connected or creating rooms", async () => {
  await assert.rejects(syncAllRooms({ trigger: "manual" }), /sync failed/i);
  const s = await connectionState();
  assert.notEqual(s.state, "CONNECTED");
  assert.equal(s.locked, false);
  assert.equal(await Room.count(), 0, "no fake rooms were created");
});

test("a failed push request is recorded as a synchronization error", async () => {
  const bad = await call("POST", "/frontdesk/rooms", { roomNumber: "101" });
  assert.equal(bad.status, 422);
  const s = await connectionState();
  assert.equal(s.state, "SYNC_ERROR");
  assert.match(s.lastError, /Validation failed/);
  assert.equal(s.locked, false, "an error before any room was received does not lock management");
});

test("first room from FrontDeskFlow: Connected, and room management is locked in the backend", async () => {
  const r = await call("POST", "/frontdesk/rooms", fdRoom(101));
  assert.equal(r.status, 201);
  const s = await connectionState();
  assert.equal(s.state, "CONNECTED", "the earlier error is cleared by the successful request");
  assert.equal(s.locked, true);
  assert.equal(s.linkedRooms, 1);

  await assert.rejects(createRoom({ roomNo: "555", type: "Standard Twin", floor: 5 }, admin.id), { status: 403 });
  const room = await Room.findOne({ where: { externalId: "FDF-101" } });
  await assert.rejects(updateRoom(room.id, { type: "Family Room", floor: 1 }, admin.id), { status: 403 });
  await assert.rejects(updateRoom(room.id, { notes: "hand edit" }, admin.id), { status: 403 });
  await assert.rejects(deleteRoom(room.id, admin.id), { status: 403 });
  assert.equal(await Room.count({ where: { roomNo: "555" } }), 0);
  assert.ok(await Room.findByPk(room.id), "room survived the delete attempt");
});

test("locked: housekeeping status can still be set, record fields stay as FrontDeskFlow sent them", async () => {
  const room = await Room.findOne({ where: { externalId: "FDF-101" } });
  await updateRoom(room.id, { type: room.type, floor: String(room.floor), status: "VACANT_DIRTY" }, admin.id);
  assert.equal((await room.reload()).status, "VACANT_DIRTY");
});

test("the admin HTTP routes are not reachable without a session", async () => {
  for (const [path, body] of [["/admin/rooms", { roomNo: "777", type: "Standard Twin", floor: "7" }], ["/admin/rooms/1/delete", {}], ["/admin/rooms/1", { type: "Family Room" }]]) {
    const res = await fetch(root + path, { method: "POST", redirect: "manual", body: new URLSearchParams(body) });
    assert.ok([301, 302, 401, 403].includes(res.status), `${path} → ${res.status}`);
  }
  assert.equal(await Room.count({ where: { roomNo: "777" } }), 0);
});

test("repeated and conflicting requests never create duplicates", async () => {
  assert.equal((await call("POST", "/frontdesk/rooms", fdRoom(101))).status, 200);
  assert.equal((await call("POST", "/frontdesk/rooms", fdRoom(101))).status, 200);
  assert.equal(await Room.count({ where: { externalId: "FDF-101" } }), 1);
  // Same room number, different external id (another building): rejected, never merged.
  const clash = await call("POST", "/frontdesk/rooms", fdRoom(101, { externalRoomId: "FDF-B-101" }));
  assert.equal(clash.status, 409);
  assert.equal(await Room.count({ where: { roomNo: "101" } }), 1);
  assert.equal((await connectionState()).state, "SYNC_ERROR");
});

test("update from FrontDeskFlow reaches RoomCare and clears the error", async () => {
  const r = await call("PUT", "/frontdesk/rooms/FDF-101", { roomType: "Junior Suite", floor: 1, description: "Corner" });
  assert.equal(r.status, 200);
  const room = await Room.findOne({ where: { externalId: "FDF-101" } });
  assert.equal(room.type, "Junior Suite");
  assert.equal(room.description, "Corner");
  const s = await connectionState();
  assert.equal(s.state, "CONNECTED");
  assert.ok(s.lastSuccessAt);
});

test("delete in FrontDeskFlow archives the room and keeps its housekeeping history", async () => {
  const room = await Room.findOne({ where: { externalId: "FDF-101" } });
  await CleaningTask.create({ code: "T-ARCH", roomId: room.id, taskType: "CHECKOUT_CLEAN", title: "Checkout clean", priority: "MEDIUM", status: "PENDING", source: "MANUAL" });

  const del = await call("DELETE", "/frontdesk/rooms/FDF-101");
  assert.equal(del.status, 200);
  assert.equal(del.body.data.archived, true);
  assert.equal(del.body.openCleaningTasks, 1);
  assert.equal((await call("DELETE", "/frontdesk/rooms/FDF-101")).body.alreadyArchived, true);

  assert.equal(await Room.count({ where: { externalId: "FDF-101" } }), 1, "row kept");
  assert.equal(await CleaningTask.count({ where: { roomId: room.id } }), 1, "task kept and still linked");
  assert.equal((await listRooms()).length, 0, "not offered for new work");
  assert.equal((await listRooms({}, { includeArchived: true })).length, 1);
  assert.equal((await board()).total, 0);
  assert.equal((await board("", { includeArchived: true })).total, 1);

  assert.equal((await call("GET", "/frontdesk/rooms")).body.data.length, 0);
  assert.equal((await call("GET", "/frontdesk/rooms?archived=all")).body.data.length, 1);

  const back = await call("PUT", "/frontdesk/rooms/FDF-101", { archived: false });
  assert.equal(back.body.data.archived, false);
  assert.equal((await listRooms()).length, 1);
});

test("room endpoints require the API key; unknown rooms are reported", async () => {
  assert.equal((await call("DELETE", "/frontdesk/rooms/FDF-101", undefined, {})).status, 401);
  assert.equal((await call("DELETE", "/frontdesk/rooms/NOPE")).status, 404);
  assert.equal(await IntegrationEvent.count({ where: { eventType: "RoomArchived", status: "REJECTED" } }), 1);
  assert.equal((await connectionState()).state, "SYNC_ERROR");
});
