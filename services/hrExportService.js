// Housekeeping records for an external HR/Payroll system.
//
// RoomCare only provides the facts it actually records — who cleaned which room, when the task was assigned,
// started and finished, and how it went. It does not compute pay, payslips, deductions or overtime pay:
// that is HR/Payroll's job. Attendance (time-in/time-out) and overtime approval are not tracked by RoomCare,
// and the export says so instead of inventing numbers.
//
// Duplicate prevention: every record has a stable recordId (the task code). HR/Payroll pulls records with
// ?pending=1 and then acknowledges them with a batchId; acknowledged records are marked hrExportedAt and are
// not returned as pending again. Re-sending the same batchId returns the original result.
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, CleaningTask, Room, User, Inspection, IntegrationEvent } from "../models/index.js";
import { TaskStatus, ACTIVE_TASK_STATUSES, housekeepingStatus, InspectionResult, IntegrationStatus as S } from "../models/enums.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";

const COMPLETED = [TaskStatus.DONE, TaskStatus.INSPECTED];
const BATCH_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 93;

const minutes = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const localDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

// from/to are local calendar days (YYYY-MM-DD), both inclusive. Default: the last 7 days.
export const parseRange = ({ from, to } = {}) => {
  const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
  const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 6 * 864e5);
  if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError("from and to must be dates in YYYY-MM-DD format");
  }
  if (!from) start.setHours(0, 0, 0, 0);
  if (start > end) throw new AppError("from must not be after to");
  if ((end - start) / 864e5 > MAX_RANGE_DAYS) throw new AppError(`The range can be at most ${MAX_RANGE_DAYS} days`);
  return { start, end };
};

const includes = [
  { model: Room, as: "room", attributes: ["id", "roomNo", "floor", "type"] },
  { model: User, as: "housekeeper", attributes: ["id", "name", "staffCode", "shift"] },
];

const toRecord = (t) => ({
  recordId: t.code,
  taskId: t.id,
  employee: { roomCareId: t.housekeeper?.id ?? null, staffCode: t.housekeeper?.staffCode ?? null, name: t.housekeeper?.name ?? null, shift: t.housekeeper?.shift ?? null },
  room: { roomNo: t.room?.roomNo ?? null, floor: t.room?.floor ?? null, type: t.room?.type ?? null },
  task: { type: t.taskType, description: t.title, priority: t.priority, source: t.source },
  assignedAt: iso(t.assignedAt || (t.housekeeperId ? t.createdAt : null)),
  startedAt: iso(t.startedAt),
  completedAt: iso(t.completedAt),
  verifiedAt: iso(t.inspectedAt),
  dueAt: iso(t.dueAt),
  status: t.status,
  statusLabel: housekeepingStatus(t),
  durationMinutes: minutes(t.startedAt, t.completedAt),
  completedOnTime: t.dueAt && t.completedAt ? new Date(t.completedAt) <= new Date(t.dueAt) : null,
  hrExport: { exportedAt: iso(t.hrExportedAt), batchId: t.hrExportBatch || null },
});

// A. Completed job logs (status=completed, by completion date) or every assigned task (status=all, by assignment date).
export const jobLogs = async ({ from, to, status = "completed", pending, limit = 500, offset = 0 } = {}) => {
  const { start, end } = parseRange({ from, to });
  if (!["completed", "all"].includes(status)) throw new AppError('status must be "completed" or "all"');
  const where = { housekeeperId: { [Op.ne]: null } };
  if (status === "completed") {
    where.status = COMPLETED;
    where.completedAt = { [Op.between]: [start, end] };
  } else {
    where[Op.or] = [{ assignedAt: { [Op.between]: [start, end] } }, { assignedAt: null, createdAt: { [Op.between]: [start, end] } }];
  }
  if (pending) where.hrExportedAt = null;
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows, count } = await CleaningTask.findAndCountAll({
    where, include: includes, order: [[status === "completed" ? "completedAt" : "createdAt", "ASC"], ["id", "ASC"]], limit: lim, offset: off,
  });
  return {
    from: localDay(start), to: localDay(end), status, pendingOnly: Boolean(pending),
    total: count, limit: lim, offset: off, records: rows.map(toRecord),
  };
};

// Marks records as received by HR/Payroll. Idempotent per batchId.
export const acknowledge = async ({ batchId, recordIds } = {}) => {
  if (!BATCH_ID.test(String(batchId || ""))) throw new AppError("batchId is required (1–100 chars: letters, digits, . _ : -)");
  if (!Array.isArray(recordIds) || !recordIds.length || recordIds.length > 1000 || !recordIds.every((r) => typeof r === "string" && r.length <= 50)) {
    throw new AppError("recordIds must be a list of 1–1000 record ids");
  }
  const ids = [...new Set(recordIds)];

  try {
    return await sequelize.transaction(async (transaction) => {
      const event = await IntegrationEvent.create({
        system: "HR", direction: "IN", eventType: "JobLogsAcknowledged", eventId: String(batchId),
        status: S.PROCESSED, occurredAt: new Date(), processedAt: new Date(), payload: { recordIds: ids },
      }, { transaction });

      const tasks = await CleaningTask.findAll({ where: { code: ids }, transaction, lock: transaction.LOCK.UPDATE });
      const byCode = new Map(tasks.map((t) => [t.code, t]));
      const out = { batchId: String(batchId), acknowledged: [], alreadyAcknowledged: [], notCompleted: [], notFound: [] };
      const now = new Date();
      for (const code of ids) {
        const t = byCode.get(code);
        if (!t) out.notFound.push(code);
        else if (!COMPLETED.includes(t.status) || !t.housekeeperId) out.notCompleted.push(code);
        else if (t.hrExportedAt) out.alreadyAcknowledged.push({ recordId: code, batchId: t.hrExportBatch, exportedAt: iso(t.hrExportedAt) });
        else {
          await t.update({ hrExportedAt: now, hrExportBatch: String(batchId) }, { transaction });
          out.acknowledged.push(code);
        }
      }
      await event.update({ response: JSON.stringify(out) }, { transaction });
      return out;
    }).then(async (out) => {
      await logAction(null, "HR_EXPORT_ACK", "IntegrationEvent", null, `Batch ${out.batchId}: ${out.acknowledged.length} record(s) acknowledged`);
      return out;
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const event = await IntegrationEvent.findOne({ where: { system: "HR", direction: "IN", eventId: String(batchId) } });
    await event.increment("duplicateCount");
    return { ...JSON.parse(event.response || "{}"), duplicate: true };
  }
};

// C/D/E. Work time and performance per housekeeper for a period.
export const workSummary = async ({ from, to } = {}) => {
  const { start, end } = parseRange({ from, to });
  const [completed, open, fails] = await Promise.all([
    CleaningTask.findAll({ where: { housekeeperId: { [Op.ne]: null }, status: COMPLETED, completedAt: { [Op.between]: [start, end] } }, include: includes }),
    CleaningTask.findAll({ where: { housekeeperId: { [Op.ne]: null }, status: ACTIVE_TASK_STATUSES }, include: includes }),
    Inspection.findAll({
      where: { result: InspectionResult.FAIL, createdAt: { [Op.between]: [start, end] }, taskId: { [Op.ne]: null } },
      include: [{ model: CleaningTask, as: "task", attributes: ["id", "code", "housekeeperId"] }],
    }),
  ]);

  const now = new Date();
  const people = new Map();
  const row = (t) => {
    const h = t.housekeeper;
    if (!people.has(h.id)) {
      people.set(h.id, {
        employee: { roomCareId: h.id, staffCode: h.staffCode, name: h.name, shift: h.shift },
        completedTasks: 0, taskMinutes: 0, averageTaskMinutes: null, completedOnTime: 0, completedLate: 0,
        unfinishedTasks: 0, overdueUnfinishedTasks: 0, failedInspections: 0, days: new Map(),
      });
    }
    return people.get(h.id);
  };

  for (const t of completed) {
    const p = row(t);
    p.completedTasks++;
    const m = minutes(t.startedAt, t.completedAt);
    if (m != null) p.taskMinutes += m;
    if (t.dueAt) (new Date(t.completedAt) <= new Date(t.dueAt) ? p.completedOnTime++ : p.completedLate++);
    const day = localDay(t.startedAt || t.completedAt);
    const d = p.days.get(day) || { date: day, firstTaskStart: null, lastTaskCompletion: null, tasks: 0, taskMinutes: 0 };
    d.tasks++;
    d.taskMinutes += m || 0;
    if (t.startedAt && (!d.firstTaskStart || t.startedAt < d.firstTaskStart)) d.firstTaskStart = t.startedAt;
    if (!d.lastTaskCompletion || t.completedAt > d.lastTaskCompletion) d.lastTaskCompletion = t.completedAt;
    p.days.set(day, d);
  }
  for (const t of open) {
    const p = row(t);
    p.unfinishedTasks++;
    if (t.dueAt && new Date(t.dueAt) < now) p.overdueUnfinishedTasks++;
  }
  for (const i of fails) {
    const p = people.get(i.task?.housekeeperId);
    if (p) p.failedInspections++;
  }

  const employees = [...people.values()]
    .map((p) => ({
      ...p,
      averageTaskMinutes: p.completedTasks ? Math.round(p.taskMinutes / p.completedTasks) : null,
      taskHours: Math.round((p.taskMinutes / 60) * 100) / 100,
      activityByDay: [...p.days.values()].map((d) => ({ ...d, firstTaskStart: iso(d.firstTaskStart), lastTaskCompletion: iso(d.lastTaskCompletion) })),
      days: undefined,
    }))
    .sort((a, b) => String(a.employee.name).localeCompare(String(b.employee.name)));

  return {
    from: localDay(start), to: localDay(end), generatedAt: now.toISOString(),
    attendance: { tracked: false, note: "RoomCare does not record time-in/time-out. activityByDay shows first task start and last task completion only." },
    workHours: { tracked: "task time only", note: "taskMinutes is the time between starting and completing each cleaning task, not shift hours." },
    overtime: { tracked: false, note: "RoomCare has no overtime records or approval process; overtime is determined by HR/Payroll." },
    employees,
  };
};

// Same data as the job-log API, as CSV for the admin Reports page.
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const jobLogsCsv = async (days = 30) => {
  const to = localDay(new Date());
  const from = localDay(new Date(Date.now() - (days - 1) * 864e5));
  const { records } = await jobLogs({ from, to, status: "completed", limit: 1000 });
  const header = ["Record ID", "Staff code", "Housekeeper", "Room", "Task", "Source", "Assigned at", "Started at", "Completed at", "Verified at", "Minutes", "Due at", "On time", "Status", "HR batch"];
  const lines = records.map((r) => [
    r.recordId, r.employee.staffCode, r.employee.name, r.room.roomNo, r.task.description, r.task.source, r.assignedAt, r.startedAt, r.completedAt,
    r.verifiedAt, r.durationMinutes, r.dueAt, r.completedOnTime == null ? "" : r.completedOnTime ? "yes" : "no", r.statusLabel, r.hrExport.batchId,
  ]);
  return [header, ...lines].map((r) => r.map(csvCell).join(",")).join("\r\n");
};

export const hrExportStats = async () => ({
  pending: await CleaningTask.count({ where: { status: COMPLETED, housekeeperId: { [Op.ne]: null }, hrExportedAt: null } }),
  exported: await CleaningTask.count({ where: { hrExportedAt: { [Op.ne]: null } } }),
  lastBatches: await IntegrationEvent.findAll({ where: { system: "HR" }, order: [["createdAt", "DESC"]], limit: 10 }),
});
