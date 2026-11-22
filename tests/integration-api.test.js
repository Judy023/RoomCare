// API tests for /api/integrations/*. Run with: npm test
// Uses its own database (RoomCare_test, created and wiped by this file) so real data is never touched.
process.env.DB_NAME = "RoomCare_test";
process.env.FRONTDESK_API_KEY = "test-frontdesk-key";
process.env.STAFFPAY_API_KEY = "test-staffpay-key";
process.env.PMS_MODE = "mock";
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection({ host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || "root", password: process.env.DB_PASS || "" });
await conn.query("CREATE DATABASE IF NOT EXISTS RoomCare_test");
await conn.end();

const { default: app } = await import("../index.js");
const m = await import("../models/index.js");
const { startTask, completeTask } = await import("../services/taskService.js");
const { sequelize, User, Room, CleaningTask, WorkOrder, Inspection, IntegrationEvent, SystemLog } = m;

let server, base, hk, tech, admin;
const FD = { Authorization: "Bearer test-frontdesk-key", "Content-Type": "application/json" };
const SP = { Authorization: "Bearer test-staffpay-key" };
const call = async (method, path, { headers = FD, body } = {}) => {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const room = (n, extra = {}) => ({ externalRoomId: `FDF-${n}`, roomNumber: String(n), roomType: "Deluxe King", floor: Math.floor(n / 100), description: `Room ${n}`, ...extra });
const waitFor = async (fn) => {
  for (let i = 0; i < 60; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

before(async () => {
  await sequelize.sync({ force: true });
  hk = await User.create({ name: "Hana Housekeeper", email: "hk@test.local", password: "x", role: "housekeeper", staffCode: "HK-001", phone: "+63-917-555-0100", shift: "AM" });
  tech = await User.create({ name: "Tony Tech", email: "tech@test.local", password: "x", role: "technician", staffCode: "TE-001" });
  admin = await User.create({ name: "Ada Admin", email: "admin@test.local", password: "x", role: "admin" });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}/api/integrations`;
});
after(async () => { server?.close(); await sequelize.close(); });

test("auth: missing, wrong and cross-system keys are rejected", async () => {
  assert.equal((await call("GET", "/frontdesk/rooms", { headers: {} })).status, 401);
  assert.equal((await call("GET", "/frontdesk/rooms", { headers: { Authorization: "Bearer nope" } })).status, 401);
  const cross = await call("GET", "/staffpay/job-logs", { headers: FD });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.success, false);
  assert.equal((await call("GET", "/frontdesk/rooms", { headers: { "X-API-Key": "test-frontdesk-key" } })).status, 200);
});

test("1. FrontDeskFlow adds a room -> RoomCare creates it", async () => {
  const r = await call("POST", "/frontdesk/rooms", { body: room(101) });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  assert.equal(r.body.data.roomNumber, "101");
  assert.equal(r.body.data.occupancyStatus, "Vacant");
  assert.equal(r.body.data.housekeepingStatus, "Clean");
  assert.equal((await call("GET", "/frontdesk/rooms/FDF-101")).body.data.roomType, "Deluxe King");
  assert.equal((await call("GET", "/frontdesk/rooms/NOPE")).status, 404);
});

test("validation: bad room payload -> 422 with field details, bad JSON -> 400", async () => {
  const r = await call("POST", "/frontdesk/rooms", { body: { roomNumber: "!!", floor: "x" } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "VALIDATION_ERROR");
  assert.ok(r.body.error.details.length >= 3);
  const bad = await fetch(base + "/frontdesk/rooms", { method: "POST", headers: FD, body: "{not json" });
  assert.equal(bad.status, 400);
});

test("9. duplicate room sync does not create duplicates", async () => {
  const again = await call("POST", "/frontdesk/rooms", { body: room(101) });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(await Room.count({ where: { roomNo: "101" } }), 1);
  const results = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/frontdesk/rooms", { body: room(102) })));
  assert.ok(results.every((x) => [200, 201].includes(x.status)));
  assert.equal(await Room.count({ where: { roomNo: "102" } }), 1);
  assert.equal((await call("POST", "/frontdesk/rooms", { body: room(101, { externalRoomId: "FDF-OTHER" }) })).status, 409);
  await Room.create({ roomNo: "103", type: "Standard Twin", floor: 1 });
  const link = await call("POST", "/frontdesk/rooms", { body: room(103) });
  assert.equal(link.body.linked, true);
  assert.equal(await Room.count({ where: { roomNo: "103" } }), 1);
  const k = { ...FD, "Idempotency-Key": "evt-room-104" };
  await call("POST", "/frontdesk/rooms", { headers: k, body: room(104) });
  assert.equal((await call("POST", "/frontdesk/rooms", { headers: k, body: room(104) })).body.duplicate, true);
});

test("2. FrontDeskFlow updates a room -> RoomCare updates it", async () => {
  const r = await call("PUT", "/frontdesk/rooms/FDF-101", { body: { roomType: "Junior Suite", floor: 2, description: "Renovated", housekeepingStatus: "Dirty" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.roomType, "Junior Suite");
  assert.equal(r.body.data.floor, 2);
  assert.deepEqual(r.body.ignoredFields, ["housekeepingStatus"]); // RoomCare owns housekeeping status
  assert.equal(r.body.data.housekeepingStatus, "Clean");
  assert.equal((await call("PUT", "/frontdesk/rooms/FDF-101", { body: {} })).status, 422);
  assert.equal((await call("PUT", "/frontdesk/rooms/FDF-101", { body: { roomNumber: "102" } })).status, 409);
  const occ = await call("PUT", "/frontdesk/rooms/FDF-102", { body: { roomStatus: "Occupied" } });
  assert.equal(occ.body.data.occupancyStatus, "Occupied");
});

test("3. checkout event -> room Dirty and one cleaning task", async () => {
  const body = { eventId: "co-1", externalRoomId: "FDF-102", occurredAt: new Date().toISOString() };
  const r = await call("POST", "/frontdesk/checkout", { body });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.taskCreated, true);
  assert.equal(r.body.data.room.housekeepingStatus, "Dirty");
  assert.equal(r.body.data.room.occupancyStatus, "Vacant");
  assert.ok((await call("GET", "/frontdesk/rooms?housekeeping_status=Dirty")).body.data.some((x) => x.externalRoomId === "FDF-102"));
  assert.equal((await call("POST", "/frontdesk/checkout", { body: { externalRoomId: "FDF-102" } })).status, 422);
  assert.equal((await call("POST", "/frontdesk/checkout", { body: { eventId: "co-x", externalRoomId: "NOPE" } })).status, 404);
});

test("10. duplicate checkout does not create duplicate tasks", async () => {
  const same = await call("POST", "/frontdesk/checkout", { body: { eventId: "co-1", externalRoomId: "FDF-102" } });
  assert.equal(same.status, 200);
  assert.equal(same.body.data.duplicate, true);
  const other = await call("POST", "/frontdesk/checkout", { body: { eventId: "co-2", externalRoomId: "FDF-102" } });
  assert.equal(other.body.data.taskCreated, false);
  assert.equal(await CleaningTask.count({ where: { roomId: (await Room.findOne({ where: { roomNo: "102" } })).id } }), 1);
});

test("4+5. housekeeping completes -> Clean, and a notification for FrontDeskFlow is prepared", async () => {
  const r102 = await Room.findOne({ where: { roomNo: "102" } });
  const task = await CleaningTask.findOne({ where: { roomId: r102.id } });
  await task.update({ housekeeperId: hk.id, adminId: admin.id, assignedAt: new Date(Date.now() - 3600e3) });
  await startTask(task.id, hk);
  assert.equal((await call("GET", "/frontdesk/rooms/FDF-102")).body.data.housekeepingStatus, "In Progress");
  await new Promise((r) => setTimeout(r, 1100));
  await completeTask(task.id, hk, "all done");
  const detail = (await call("GET", "/frontdesk/rooms/FDF-102")).body.data;
  assert.equal(detail.housekeepingStatus, "Clean");
  assert.equal(detail.occupancyStatus, "Vacant");

  const ev = await waitFor(() => IntegrationEvent.findOne({ where: { direction: "OUT", eventType: "CleaningCompleted" } }));
  assert.ok(ev, "outgoing event queued");
  const upd = await waitFor(async () => {
    const r = await call("GET", "/frontdesk/room-status-updates");
    const done = r.body.data.find((x) => x.eventType === "CleaningCompleted");
    return done && done.delivery.status === "SENT" ? r : null;
  });
  assert.ok(upd, "event delivered (mock)");
  // Dirty and In Progress changes are queued too; the Clean one is the CleaningCompleted event.
  const statuses = upd.body.data.map((x) => x.payload.room.housekeepingStatus);
  assert.ok(statuses.includes("Dirty") && statuses.includes("In Progress") && statuses.includes("Clean"), `status updates: ${statuses}`);
  const item = upd.body.data.find((x) => x.eventType === "CleaningCompleted");
  assert.equal(item.eventType, "CleaningCompleted");
  assert.equal(item.payload.room.externalRoomId, "FDF-102");
  assert.equal(item.payload.room.housekeepingStatus, "Clean");
  assert.equal(upd.body.meta.nextCursor, item.updateId);
  assert.equal((await call("GET", `/frontdesk/room-status-updates?after_id=${item.updateId}`)).body.data.length, 0);

  const cleaned = await call("GET", "/frontdesk/cleaned-rooms");
  assert.equal(cleaned.body.data.length, 1);
  assert.equal(cleaned.body.data[0].externalRoomId, "FDF-102");
  assert.equal(cleaned.body.data[0].completedBy, "Hana Housekeeper");
  assert.equal(JSON.stringify(cleaned.body).includes("hk@test.local"), false);
});

test("6+7. StaffPay retrieves job logs and work durations", async () => {
  const r102 = await Room.findOne({ where: { roomNo: "102" } });
  const task = await CleaningTask.findOne({ where: { roomId: r102.id } });
  await Inspection.create({ result: "PASS", checklist: [{ key: "a", passed: true }, { key: "b", passed: true }, { key: "c", passed: false }, { key: "d", passed: true }], adminId: admin.id, roomId: r102.id, taskId: task.id });
  const ro = await Room.create({ roomNo: "201", type: "Standard Twin", floor: 2 });
  await WorkOrder.create({
    code: "WO-T-1", category: "Plumbing", description: "Leaking tap", roomId: ro.id, assignedToId: tech.id, status: "RESOLVED",
    assignedAt: new Date(Date.now() - 7200e3), startedAt: new Date(Date.now() - 3600e3), resolvedAt: new Date(), resolutionNotes: "Replaced washer",
  });

  const all = await call("GET", "/staffpay/job-logs", { headers: SP });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 2);
  const clean = all.body.data.find((j) => j.task.type === "Cleaning");
  assert.equal(clean.employee.employeeId, "HK-001");
  assert.equal(clean.employee.name, "Hana Housekeeper");
  assert.equal(clean.room.roomNumber, "102");
  assert.ok(clean.startedAt && clean.completedAt && clean.assignedAt);
  assert.equal(clean.verification.inspector, "Ada Admin");
  assert.equal(clean.verification.qualityScore, 75);
  const text = JSON.stringify(all.body);
  assert.ok(!text.includes("hk@test.local") && !text.includes("555-0100") && !text.includes("password"), "no sensitive employee data");

  assert.equal((await call("GET", "/staffpay/employees/HK-001/job-logs", { headers: SP })).body.data.length, 1);
  assert.equal((await call("GET", "/staffpay/employees/TE-001/job-logs", { headers: SP })).body.data[0].task.type, "Maintenance");
  assert.equal((await call("GET", "/staffpay/employees/ZZZ/job-logs", { headers: SP })).status, 404);
  assert.equal((await call("GET", "/staffpay/job-logs?task_type=maintenance", { headers: SP })).body.data.length, 1);
  assert.equal((await call("GET", `/staffpay/job-logs?room_id=${ro.id}`, { headers: SP })).body.data.length, 1);
  assert.equal((await call("GET", "/staffpay/job-logs?task_status=INSPECTED", { headers: SP })).body.data.length, 0);
  assert.equal((await call("GET", "/staffpay/job-logs?task_status=bogus&start_date=2025-13-99", { headers: SP })).status, 422);
  assert.equal((await call("GET", "/staffpay/job-logs?employee_id=HK-001&task_type=CHECKOUT_CLEAN", { headers: SP })).body.data.length, 1);

  const wh = await call("GET", "/staffpay/work-hours", { headers: SP });
  assert.equal(wh.status, 200);
  const tw = wh.body.summary.find((s) => s.employee.employeeId === "TE-001");
  assert.equal(tw.recordedMinutes, 60);
  assert.match(wh.body.disclaimer, /not attendance/);
  assert.ok(wh.body.data.find((d) => d.employee.employeeId === "HK-001").durationMinutes === 0);
});

test("8. StaffPay retrieves performance and overtime records", async () => {
  const p = await call("GET", "/staffpay/performance?employee_id=HK-001", { headers: SP });
  assert.equal(p.status, 200);
  assert.equal(p.body.data.length, 1);
  assert.equal(p.body.data[0].inspections.passed, 1);
  assert.equal(p.body.data[0].inspections.averageQualityScore, 75);
  const o = await call("GET", "/staffpay/overtime", { headers: SP });
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.data, []);
  assert.equal(o.body.meta.tracked, false);
});

test("requests are logged and unknown routes return JSON 404", async () => {
  assert.ok(await waitFor(async () => (await SystemLog.count({ where: { action: "INTEGRATION_API" } })) > 5));
  const r = await call("GET", "/frontdesk/nothing");
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
});
