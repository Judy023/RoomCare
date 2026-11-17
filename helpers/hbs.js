import hbs from "hbs";
import { ROLE_LABELS, TASK_TYPES, housekeepingStatus, roomStatusLabel } from "../models/enums.js";

const { SafeString, Utils } = hbs.handlebars;
const esc = Utils.escapeExpression;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// All badge / room-card tones are tints of the RoomCare palette (see partials/head.xian).
const T = {
  danger: "bg-terracotta-soft text-terracotta border-terracotta/25",
  warn: "bg-gold-soft text-gold-deep border-gold/30",
  info: "bg-steel-soft text-steel border-steel/25",
  ok: "bg-leaf-soft text-leaf border-leaf/25",
  neutral: "bg-sage text-moss border-line",
};
const ROOM_COLORS = {
  VACANT_DIRTY: T.danger,
  CLEANING: T.warn,
  VACANT_CLEAN: T.info,
  INSPECTED: T.ok,
  OCCUPIED: T.neutral,
  OUT_OF_ORDER: "bg-white text-moss border-line border-dashed",
};
const STATUS_COLORS = {
  ...ROOM_COLORS,
  PENDING: T.warn,
  IN_PROGRESS: T.info,
  DONE: T.ok,
  OPEN: T.danger,
  ASSIGNED: T.warn,
  ON_HOLD: "bg-white text-gold-deep border-gold/40 border-dashed",
  RESOLVED: T.info,
  CLOSED: T.ok,
  CANCELLED: T.neutral,
  PASS: T.ok,
  FAIL: T.danger,
  SMS: T.info,
  EMAIL: T.info,
  PUSH: T.neutral,
  IN_APP: T.neutral,
};
const PRIORITY_COLORS = {
  LOW: T.neutral,
  MEDIUM: T.info,
  HIGH: T.warn,
  URGENT: "bg-terracotta text-white border-terracotta",
};

// Sidebar icons (24px outline, stroke = currentColor), keyed by nav href.
const WRENCH = '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>';
const ICON_PATHS = {
  "/dashboard": '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>',
  "/tasks/my": '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  "/work-orders/my": WRENCH,
  "/rooms": '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/>',
  "/tasks": '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  "/work-orders": WRENCH,
  "/work-orders/new": '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  "/inspections": '<path d="M9 12l2 2 4-4"/><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>',
  "/inventory": '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  "/reports": '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  "/admin/users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  "/admin/rooms": '<path d="M3 7h18v13H3z"/><path d="M3 12h18M9 7v13"/>',
  "/admin/logs": '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  "/admin/integrations": '<path d="M7 7h10M7 7l3-3M7 7l3 3"/><path d="M17 17H7M17 17l-3-3M17 17l-3 3"/>',
};
const navIcon = (href) =>
  new SafeString('<svg class="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[href] || '<circle cx="12" cy="12" r="3"/>') + "</svg>");

// Room statuses that still drive the workflow but are never shown on screen.
const HIDDEN_ROOM_STATUSES = ["OCCUPIED", "OUT_OF_ORDER"];
const hiddenStatus = (v) => HIDDEN_ROOM_STATUSES.includes(v);
// Statuses left out of the dashboard summary cards (the room board shows Vacant Room as a filter).
const hiddenSummaryStatus = (v) => hiddenStatus(v) || v === "INSPECTED";

const label = (v) => (v ? String(v).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "");
const pad = (n) => String(n).padStart(2, "0");
const pill = (classes, text) =>
  new SafeString(`<span class="inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${classes}">${esc(text)}</span>`);

const helpers = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  and: (...args) => args.slice(0, -1).every(Boolean),
  or: (...args) => args.slice(0, -1).some(Boolean),
  not: (v) => !v,
  gt: (a, b) => Number(a) > Number(b),
  // Accepts an array or a comma-separated string: {{#if (includes "CLOSED,CANCELLED" status)}}
  includes: (list, v) => (typeof list === "string" ? list.split(",") : [].concat(list || [])).map(String).includes(String(v)),
  split: (s) => String(s || "").split(","),
  label,
  roleLabel: (role) => ROLE_LABELS[role] || label(role),
  taskTypeLabel: (t) => TASK_TYPES[t] || label(t),
  hiddenStatus,
  hiddenSummaryStatus,
  roomLabel: (status) => roomStatusLabel(status),
  roomBadge: (status) => hiddenStatus(status) ? "" : pill(STATUS_COLORS[status] || "bg-sage text-moss border-line", roomStatusLabel(status)),
  badge: (status) => hiddenStatus(status) ? "" : pill(STATUS_COLORS[status] || "bg-sage text-moss border-line", label(status)),
  priorityBadge: (p) => pill(PRIORITY_COLORS[p] || PRIORITY_COLORS.LOW, label(p)),
  roomColor: (status) => ROOM_COLORS[status] || "",
  navIcon,
  initials: (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase(),
  selected: (a, b) => (String(a) === String(b) ? "selected" : ""),
  checked: (v) => (v ? "checked" : ""),
  formatDate: (d) => {
    if (!d) return "—";
    const date = new Date(d);
    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },
  formatTime: (d) => (d ? `${pad(new Date(d).getHours())}:${pad(new Date(d).getMinutes())}` : "—"),
  inputDateTime: (d) => {
    if (!d) return "";
    const x = new Date(d);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
  },
  timeAgo: (d) => {
    if (!d) return "—";
    const mins = Math.round((Date.now() - new Date(d)) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
    return `${Math.floor(mins / 1440)} d ago`;
  },
  minutesBetween: (a, b) => (a && b ? `${Math.round((new Date(b) - new Date(a)) / 60000)} min` : "—"),
  fallback: (v, alt) => (v == null || v === "" ? alt : v),
  // Housekeeping status of a cleaning task (Pending Cleaning, Assigned, Cleaning In Progress, ...).
  taskBadge: (task) => {
    const text = housekeepingStatus(task);
    const tone = { "Pending Cleaning": T.danger, Assigned: T.warn, "Cleaning In Progress": T.info, "Cleaning Completed": T.ok, Verified: T.ok }[text] || T.neutral;
    return pill(tone, text);
  },
  integrationBadge: (status) => pill({ PROCESSED: T.ok, SENT: T.ok, PENDING: T.warn, SENDING: T.info, FAILED: T.danger, REJECTED: T.danger }[status] || T.neutral, label(status)),
  json: (v) => (v == null ? "" : JSON.stringify(v)),
  nl2br: (text) => new SafeString(esc(text || "").replace(/\n/g, "<br>")),
};

for (const [name, fn] of Object.entries(helpers)) hbs.registerHelper(name, fn);
