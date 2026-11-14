import { Op } from "sequelize";
import { Room, CleaningTask, WorkOrder, Inspection, PartUsage, InventoryItem, User } from "../models/index.js";
import { ADMIN_ROOM_STATUSES, TASK_STATUSES, WO_STATUSES, WO_CATEGORIES, PRIORITIES, ACTIVE_WO_STATUSES, RoomStatus } from "../models/enums.js";
import { toPlain } from "../utils/http.js";
import { computeSLA } from "./workOrderService.js";
import { lowStockItems } from "./inventoryService.js";

const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const avg = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
const round = (n, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

// [{ label, value, pct }] where pct is relative to the largest value, for the bar lists.
const bars = (keys, countFn) => {
  const rows = keys.map((key) => ({ key, value: countFn(key) }));
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => ({ ...r, pct: Math.round((r.value / max) * 100) }));
};

// 7.0 Generate Reports: the KPI dashboard for the System Admin, read from D1–D4.
export const kpis = async (days = 30) => {
  const since = new Date(Date.now() - days * 864e5);

  const rooms = await Room.findAll({ attributes: ["status"], raw: true });
  const tasks = toPlain(await CleaningTask.findAll({
    where: { createdAt: { [Op.gte]: since } },
    include: [{ model: User, as: "housekeeper", attributes: ["id", "name"] }],
  }));
  const wos = toPlain(await WorkOrder.findAll({
    where: { reportedAt: { [Op.gte]: since } },
    include: [{ model: User, as: "assignedTo", attributes: ["id", "name"] }],
  }));
  const openWos = toPlain(await WorkOrder.findAll({ where: { status: ACTIVE_WO_STATUSES } }));
  const inspections = await Inspection.findAll({ where: { createdAt: { [Op.gte]: since } }, attributes: ["result"], raw: true });
  const parts = toPlain(await PartUsage.findAll({
    where: { createdAt: { [Op.gte]: since } },
    include: [{ model: InventoryItem, as: "item" }],
  }));

  const cleaned = tasks.filter((t) => t.startedAt && t.completedAt);
  const resolved = wos.filter((w) => w.resolvedAt);
  const passed = inspections.filter((i) => i.result === "PASS").length;

  const byHousekeeper = new Map();
  for (const t of tasks) {
    if (!t.housekeeper) continue;
    const row = byHousekeeper.get(t.housekeeper.id) || { name: t.housekeeper.name, assigned: 0, done: 0, minutes: [] };
    row.assigned++;
    if (t.completedAt) row.done++;
    if (t.startedAt && t.completedAt) row.minutes.push(minutesBetween(t.startedAt, t.completedAt));
    byHousekeeper.set(t.housekeeper.id, row);
  }

  const byTechnician = new Map();
  for (const w of wos) {
    if (!w.assignedTo) continue;
    const row = byTechnician.get(w.assignedTo.id) || { name: w.assignedTo.name, assigned: 0, resolved: 0, hours: [], overdue: 0 };
    row.assigned++;
    if (w.resolvedAt) {
      row.resolved++;
      row.hours.push(minutesBetween(w.reportedAt, w.resolvedAt) / 60);
    }
    if (computeSLA(w).overdue) row.overdue++;
    byTechnician.set(w.assignedTo.id, row);
  }

  const partsByItem = new Map();
  for (const p of parts) {
    const row = partsByItem.get(p.itemId) || { name: p.item?.name ?? "—", unit: p.item?.unit ?? "", qty: 0, cost: 0 };
    row.qty += p.qty;
    row.cost += p.qty * Number(p.item?.unitCost ?? 0);
    partsByItem.set(p.itemId, row);
  }

  const lowStock = toPlain(await lowStockItems());

  return {
    days,
    tiles: {
      totalRooms: rooms.length,
      sellable: rooms.filter((r) => r.status === RoomStatus.INSPECTED).length,
      outOfOrder: rooms.filter((r) => r.status === RoomStatus.OUT_OF_ORDER).length,
      tasksCreated: tasks.length,
      tasksDone: tasks.filter((t) => t.completedAt).length,
      avgCleanMinutes: round(avg(cleaned.map((t) => minutesBetween(t.startedAt, t.completedAt))), 0),
      workOrders: wos.length,
      openWorkOrders: openWos.length,
      overdueOpen: openWos.filter((w) => computeSLA(w).overdue).length,
      mttrHours: round(avg(resolved.map((w) => minutesBetween(w.reportedAt, w.resolvedAt) / 60))),
      slaMet: resolved.length ? Math.round((resolved.filter((w) => !computeSLA(w).overdue).length / resolved.length) * 100) : null,
      inspections: inspections.length,
      passRate: inspections.length ? Math.round((passed / inspections.length) * 100) : null,
      lowStock: lowStock.length,
      partsCost: [...partsByItem.values()].reduce((s, p) => s + p.cost, 0).toFixed(2),
    },
    roomStatus: bars(ADMIN_ROOM_STATUSES, (s) => rooms.filter((r) => r.status === s).length),
    taskStatus: bars(TASK_STATUSES, (s) => tasks.filter((t) => t.status === s).length),
    woStatus: bars(WO_STATUSES, (s) => wos.filter((w) => w.status === s).length),
    woCategory: bars(WO_CATEGORIES, (c) => wos.filter((w) => w.category === c).length).filter((r) => r.value > 0),
    openByPriority: bars(PRIORITIES, (p) => openWos.filter((w) => w.priority === p).length),
    housekeepers: [...byHousekeeper.values()]
      .map((r) => ({ ...r, avgMinutes: round(avg(r.minutes), 0) }))
      .sort((a, b) => b.done - a.done),
    technicians: [...byTechnician.values()]
      .map((r) => ({ ...r, avgHours: round(avg(r.hours)) }))
      .sort((a, b) => b.resolved - a.resolved),
    parts: [...partsByItem.values()].map((p) => ({ ...p, cost: p.cost.toFixed(2) })).sort((a, b) => b.qty - a.qty),
    lowStock,
  };
};

const csvCell = (v) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const workOrdersCsv = async (days = 30) => {
  const since = new Date(Date.now() - days * 864e5);
  const rows = toPlain(await WorkOrder.findAll({
    where: { reportedAt: { [Op.gte]: since } },
    include: [
      { model: Room, as: "room", attributes: ["roomNo"] },
      { model: User, as: "reportedBy", attributes: ["name"] },
      { model: User, as: "assignedTo", attributes: ["name"] },
    ],
    order: [["reportedAt", "ASC"]],
  }));
  const header = ["Code", "Room", "Category", "Description", "Priority", "Status", "Reported by", "Technician", "Reported at", "Resolved at", "Closed at", "SLA hours", "Overdue"];
  const lines = rows.map((w) => {
    const sla = computeSLA(w);
    return [w.code, w.room?.roomNo, w.category, w.description, w.priority, w.status, w.reportedBy?.name, w.assignedTo?.name, w.reportedAt, w.resolvedAt, w.closedAt, sla.hours, sla.overdue ? "yes" : "no"];
  });
  return [header, ...lines].map((r) => r.map(csvCell).join(",")).join("\r\n");
};
