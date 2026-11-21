// Housekeeping and maintenance work records for StaffPay (served under /api/integrations/staffpay).
//
// RoomCare reports what it recorded: who did which job, when it started and finished, and how it was verified.
// It does NOT calculate pay, attendance or overtime. durationMinutes is the time between "started" and
// "completed" on a job — never official attendance or payable hours; StaffPay applies its own rules.
// Only fields StaffPay needs are returned: no email, phone or password.
import { Op } from "sequelize";
import { CleaningTask, WorkOrder, Room, User, Inspection } from "../models/index.js";
import { TaskStatus, WorkOrderStatus, TASK_TYPES, InspectionResult } from "../models/enums.js";
import { AppError } from "../utils/http.js";
import { parseRange } from "./hrExportService.js";

const MAX_ROWS = 5000;
const CLEANING_DONE = [TaskStatus.DONE, TaskStatus.INSPECTED];
const WO_DONE = [WorkOrderStatus.RESOLVED, WorkOrderStatus.CLOSED];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const minutes = (a, b) => {
  if (!a || !b) return null;
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  return m >= 0 ? m : null;
};
const day = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const fail = (errors) => { throw new AppError("Validation failed", 422, errors); };

// ── Query parameters ──────────────────────────────────────────────────────────────────────────────

const employeeLookup = async (ref) => {
  const s = String(ref).trim();
  const user = await User.findOne({
    where: { role: ["housekeeper", "technician"], [Op.or]: [{ staffCode: s }, ...(/^\d+$/.test(s) ? [{ id: Number(s) }] : [])] },
    attributes: ["id", "name", "staffCode", "role"],
  });
  if (!user) throw new AppError(`Employee ${s} not found`, 404);
  return user;
};

// Turns the query string into validated filters. employee may also be a path parameter.
export const parseFilters = async (q, employeeRef) => {
  const errors = [];
  let range;
  try {
    range = parseRange({ from: q.start_date, to: q.end_date });
  } catch (e) {
    errors.push({ field: "start_date/end_date", message: e.message.replace("from and to", "start_date and end_date").replace("from must not be after to", "start_date must not be after end_date") });
  }
  const f = { range, employee: null, roomId: null, statuses: null, taskType: null };

  if (q.room_id !== undefined) /^\d+$/.test(String(q.room_id)) ? (f.roomId = Number(q.room_id)) : errors.push({ field: "room_id", message: "must be a RoomCare room id (number)" });

  const status = String(q.task_status ?? "completed").toUpperCase();
  const known = [...CLEANING_DONE, ...WO_DONE];
  if (status === "COMPLETED") f.statuses = known;
  else if (known.includes(status)) f.statuses = [status];
  else errors.push({ field: "task_status", message: "must be completed, DONE, INSPECTED, RESOLVED or CLOSED" });

  if (q.task_type !== undefined) {
    const t = String(q.task_type).toUpperCase();
    if (t === "CLEANING" || t === "MAINTENANCE") f.taskType = { kind: t };
    else if (TASK_TYPES[t]) f.taskType = { kind: "CLEANING", sub: t };
    else errors.push({ field: "task_type", message: `must be Cleaning, Maintenance or one of ${Object.keys(TASK_TYPES).join(", ")}` });
  }
  if (errors.length) fail(errors);

  const ref = employeeRef ?? q.employee_id;
  if (ref !== undefined && ref !== "") f.employee = await employeeLookup(ref);
  return f;
};

// ── Job logs ──────────────────────────────────────────────────────────────────────────────────────

const employeeDto = (u) => (u ? { employeeId: u.staffCode || String(u.id), roomCareUserId: u.id, name: u.name, role: u.role } : null);
const roomDto = (r) => ({ roomId: r?.id ?? null, externalRoomId: r?.externalId ?? null, roomNumber: r?.roomNo ?? null });

// Latest inspection per cleaning task: the verification and quality indicator. RoomCare has no numeric rating,
// so quality is reported as the inspection result and the share of checklist items that passed.
const inspectionsByTask = async (taskIds) => {
  if (!taskIds.length) return new Map();
  const rows = await Inspection.findAll({
    where: { taskId: taskIds }, order: [["createdAt", "ASC"], ["id", "ASC"]],
    include: [{ model: User, as: "admin", attributes: ["name"] }],
  });
  const map = new Map();
  for (const i of rows) map.set(i.taskId, i); // later rows overwrite earlier ones
  return map;
};

const verification = (i) => {
  if (!i) return null;
  const items = Array.isArray(i.checklist) ? i.checklist : [];
  const passed = items.filter((c) => c.passed).length;
  return {
    inspector: i.admin?.name ?? null, result: i.result, inspectedAt: iso(i.createdAt),
    checklistPassed: passed, checklistTotal: items.length, qualityScore: items.length ? Math.round((passed / items.length) * 100) : null,
  };
};

// Every matching job (cleaning tasks and maintenance work orders), oldest completion first.
export const collectJobs = async (f) => {
  const jobs = [];
  const { start, end } = f.range;

  if (!f.taskType || f.taskType.kind === "CLEANING") {
    const statuses = f.statuses.filter((s) => CLEANING_DONE.includes(s));
    if (statuses.length) {
      const where = { status: statuses, housekeeperId: f.employee ? f.employee.id : { [Op.ne]: null }, completedAt: { [Op.between]: [start, end] } };
      if (f.roomId) where.roomId = f.roomId;
      if (f.taskType?.sub) where.taskType = f.taskType.sub;
      if (f.employee && f.employee.role !== "housekeeper") where.id = 0;
      const tasks = await CleaningTask.findAll({
        where, order: [["completedAt", "ASC"], ["id", "ASC"]], limit: MAX_ROWS,
        include: [{ model: Room, as: "room", attributes: ["id", "roomNo", "externalId"] }, { model: User, as: "housekeeper", attributes: ["id", "name", "staffCode", "role"] }],
      });
      const inspections = await inspectionsByTask(tasks.map((t) => t.id));
      for (const t of tasks) {
        jobs.push({
          sort: t.completedAt,
          jobLogId: t.code,
          employee: employeeDto(t.housekeeper),
          task: { taskId: t.id, type: "Cleaning", subType: t.taskType, description: t.title, priority: t.priority },
          room: roomDto(t.room),
          assignedAt: iso(t.assignedAt || t.createdAt),
          startedAt: iso(t.startedAt),
          completedAt: iso(t.completedAt),
          durationMinutes: minutes(t.startedAt, t.completedAt),
          status: t.status,
          verification: verification(inspections.get(t.id)),
          remarks: t.notes ?? null,
          dueAt: t.dueAt,
        });
      }
    }
  }

  if (!f.taskType || f.taskType.kind === "MAINTENANCE") {
    const statuses = f.statuses.filter((s) => WO_DONE.includes(s));
    if (statuses.length && !f.taskType?.sub) {
      const where = { status: statuses, assignedToId: f.employee ? f.employee.id : { [Op.ne]: null }, resolvedAt: { [Op.between]: [start, end] } };
      if (f.roomId) where.roomId = f.roomId;
      if (f.employee && f.employee.role !== "technician") where.id = 0;
      const orders = await WorkOrder.findAll({
        where, order: [["resolvedAt", "ASC"], ["id", "ASC"]], limit: MAX_ROWS,
        include: [{ model: Room, as: "room", attributes: ["id", "roomNo", "externalId"] }, { model: User, as: "assignedTo", attributes: ["id", "name", "staffCode", "role"] }],
      });
      for (const w of orders) {
        jobs.push({
          sort: w.resolvedAt,
          jobLogId: w.code,
          employee: employeeDto(w.assignedTo),
          task: { taskId: w.id, type: "Maintenance", subType: w.category, description: w.description, priority: w.priority },
          room: roomDto(w.room),
          assignedAt: iso(w.assignedAt),
          startedAt: iso(w.startedAt),
          completedAt: iso(w.resolvedAt),
          durationMinutes: minutes(w.startedAt, w.resolvedAt),
          status: w.status,
          verification: null, // maintenance work orders are not inspected as a job
          remarks: w.resolutionNotes ?? null,
          dueAt: null,
        });
      }
    }
  }

  return jobs.sort((a, b) => new Date(a.sort) - new Date(b.sort) || String(a.jobLogId).localeCompare(String(b.jobLogId)));
};

const page = (q) => ({
  limit: Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500),
  offset: Math.max(parseInt(q.offset, 10) || 0, 0),
});
const publicJob = ({ sort, dueAt, ...job }) => job;
const period = (f) => ({ startDate: day(f.range.start), endDate: day(f.range.end) });

// GET /job-logs and /employees/:employeeId/job-logs
export const jobLogs = async (q, employeeRef) => {
  const f = await parseFilters(q, employeeRef);
  const { limit, offset } = page(q);
  const jobs = await collectJobs(f);
  return { items: jobs.slice(offset, offset + limit).map(publicJob), meta: { ...period(f), total: jobs.length, limit, offset } };
};

// GET /work-hours — recorded job durations, plus a per-employee total. Task time only.
export const workHours = async (q) => {
  const f = await parseFilters(q);
  const { limit, offset } = page(q);
  const jobs = await collectJobs(f);
  const byEmployee = new Map();
  for (const j of jobs) {
    const key = j.employee.roomCareUserId;
    const e = byEmployee.get(key) || { employee: j.employee, jobsCompleted: 0, jobsWithDuration: 0, recordedMinutes: 0, days: new Set() };
    e.jobsCompleted++;
    if (j.durationMinutes != null) { e.jobsWithDuration++; e.recordedMinutes += j.durationMinutes; }
    e.days.add(day(j.completedAt));
    byEmployee.set(key, e);
  }
  return {
    items: jobs.slice(offset, offset + limit).map((j) => ({
      jobLogId: j.jobLogId, employee: j.employee, taskType: j.task.type, room: j.room,
      startedAt: j.startedAt, completedAt: j.completedAt, durationMinutes: j.durationMinutes,
    })),
    summary: [...byEmployee.values()].map(({ days, ...e }) => ({
      ...e, recordedHours: Math.round((e.recordedMinutes / 60) * 100) / 100, daysWithRecordedJobs: days.size,
    })),
    meta: { ...period(f), total: jobs.length, limit, offset },
    disclaimer: "durationMinutes is the time between a job's start and completion in RoomCare. It is not attendance, shift time or payable hours; StaffPay validates those.",
  };
};

// GET /overtime — RoomCare has no overtime records, so none are invented. Parameters are still validated.
export const overtime = async (q) => {
  const f = await parseFilters(q);
  return {
    items: [],
    meta: { ...period(f), total: 0, tracked: false },
    note: "RoomCare does not record or approve overtime. Overtime is determined by StaffPay from verified attendance.",
  };
};

// GET /performance — per employee quality and punctuality figures drawn from completed jobs and inspections.
export const performance = async (q) => {
  const f = await parseFilters(q);
  const jobs = await collectJobs(f);
  const people = new Map();
  for (const j of jobs) {
    const key = j.employee.roomCareUserId;
    const p = people.get(key) || {
      employee: j.employee, completedJobs: 0, cleaningJobs: 0, maintenanceJobs: 0, minutes: 0, timed: 0,
      onTime: 0, late: 0, inspected: 0, passed: 0, failed: 0, scores: [],
    };
    p.completedJobs++;
    j.task.type === "Cleaning" ? p.cleaningJobs++ : p.maintenanceJobs++;
    if (j.durationMinutes != null) { p.minutes += j.durationMinutes; p.timed++; }
    if (j.dueAt) (new Date(j.completedAt) <= new Date(j.dueAt) ? p.onTime++ : p.late++);
    if (j.verification) {
      p.inspected++;
      j.verification.result === InspectionResult.PASS ? p.passed++ : p.failed++;
      if (j.verification.qualityScore != null) p.scores.push(j.verification.qualityScore);
    }
    people.set(key, p);
  }
  return {
    items: [...people.values()].map((p) => ({
      employee: p.employee, completedJobs: p.completedJobs, cleaningJobs: p.cleaningJobs, maintenanceJobs: p.maintenanceJobs,
      averageJobMinutes: p.timed ? Math.round(p.minutes / p.timed) : null,
      completedOnTime: p.onTime, completedLate: p.late,
      inspections: {
        inspected: p.inspected, passed: p.passed, failed: p.failed, notInspected: p.cleaningJobs - p.inspected,
        averageQualityScore: p.scores.length ? Math.round(p.scores.reduce((a, b) => a + b, 0) / p.scores.length) : null,
      },
    })),
    meta: { ...period(f), total: people.size },
    note: "RoomCare has no numeric rating. Quality is the inspection result and the percentage of checklist items passed.",
  };
};
