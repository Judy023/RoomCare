import { listTasks, listForHousekeeper, historyForHousekeeper,roomsNeedingTask, assignTask, assignFormOptions, startTask, completeTask } from "../services/taskService.js";
import { listRooms } from "../services/roomService.js";
import { TASK_STATUSES } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

// Only local paths, so the "back" value cannot send anyone to another site.
const safeBack = (p) => (typeof p === "string" && /^\/(?!\/)[\w\-/?=&%.]*$/.test(p) ? p : "/tasks");

export const tasksPage = wrap(async (req, res) => {
  const status = TASK_STATUSES.includes(req.query.status) ? req.query.status : "";
  const [tasks, rooms, assignOptions, needCleaning] = await Promise.all([
    listTasks({ status }), listRooms(), assignFormOptions(), roomsNeedingTask(),
  ]);
  res.render("tasks/index", {
    title: "Cleaning Tasks",
    tasks: toPlain(tasks),
    rooms: toPlain(rooms),
    ...assignOptions,
    needCleaning: toPlain(needCleaning),
    status,
    statuses: TASK_STATUSES,
  });
});

export const createTask = wrap(async (req, res) => {
  const task = await assignTask(req.body, req.user);
  req.flash("success_msg", `${task.code} assigned — the housekeeper has been notified.`);
  res.redirect(safeBack(req.body.back));
});

export const myTasksPage = wrap(async (req, res) => {
  const tasks = toPlain(await listForHousekeeper(req.user.id));
  res.render("tasks/my", {
    title: "My Tasks",
    active: tasks.filter((t) => ["PENDING", "IN_PROGRESS"].includes(t.status)),
    done: tasks.filter((t) => !["PENDING", "IN_PROGRESS"].includes(t.status)),
  });
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d, today, yesterday) => {
  const key = d.toDateString();
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (key === today) return `Today · ${date}`;
  if (key === yesterday) return `Yesterday · ${date}`;
  return date;
};

export const workHistoryPage = wrap(async (req, res) => {
  const tasks = toPlain(await historyForHousekeeper(req.user.id));
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  const days = [];
  for (const t of tasks) {
    const day = dayLabel(new Date(t.completedAt), today, yesterday);
    if (days.at(-1)?.day !== day) days.push({ day, tasks: [] });
    days.at(-1).tasks.push(t);
  }
  res.render("tasks/history", { title: "Work History", total: tasks.length, days });
});

export const startMyTask = wrap(async (req, res) => {
  const task = await startTask(req.params.id, req.user);
  req.flash("success_msg", `${task.code} started — Room ${task.room.roomNo} is now being cleaned.`);
  res.redirect("/tasks/my");
});

export const completeMyTask = wrap(async (req, res) => {
  const task = await completeTask(req.params.id, req.user, req.body.notes);
  req.flash("success_msg", `${task.code} marked done. An admin has been notified.`);
  res.redirect("/tasks/my");
});
