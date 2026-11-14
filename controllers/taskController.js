import { listTasks, listForHousekeeper, roomsNeedingTask, assignTask, startTask, completeTask } from "../services/taskService.js";
import { listRooms } from "../services/roomService.js";
import { listStaff } from "../services/userService.js";
import { TASK_STATUSES, TASK_TYPES, PRIORITIES } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

export const tasksPage = wrap(async (req, res) => {
  const status = TASK_STATUSES.includes(req.query.status) ? req.query.status : "";
  const [tasks, rooms, housekeepers, needCleaning] = await Promise.all([
    listTasks({ status }), listRooms(), listStaff("housekeeper"), roomsNeedingTask(),
  ]);
  res.render("tasks/index", {
    title: "Cleaning Tasks",
    tasks: toPlain(tasks),
    rooms: toPlain(rooms),
    housekeepers: toPlain(housekeepers),
    needCleaning: toPlain(needCleaning),
    status,
    selectedRoomId: req.query.roomId || "",
    statuses: TASK_STATUSES,
    taskTypes: Object.entries(TASK_TYPES).map(([value, label]) => ({ value, label })),
    priorities: PRIORITIES,
  });
});

export const createTask = wrap(async (req, res) => {
  const task = await assignTask(req.body, req.user);
  req.flash("success_msg", `${task.code} assigned — the housekeeper has been notified.`);
  res.redirect("/tasks");
});

export const myTasksPage = wrap(async (req, res) => {
  const tasks = toPlain(await listForHousekeeper(req.user.id));
  res.render("tasks/my", {
    title: "My Tasks",
    active: tasks.filter((t) => ["PENDING", "IN_PROGRESS"].includes(t.status)),
    done: tasks.filter((t) => !["PENDING", "IN_PROGRESS"].includes(t.status)),
  });
});

export const startMyTask = wrap(async (req, res) => {
  const task = await startTask(req.params.id, req.user);
  req.flash("success_msg", `${task.code} started — Room ${task.room.roomNo} is now being cleaned.`);
  res.redirect("/tasks/my");
});

export const completeMyTask = wrap(async (req, res) => {
  const task = await completeTask(req.params.id, req.user, req.body.notes);
  req.flash("success_msg", `${task.code} marked done. Your supervisor has been notified.`);
  res.redirect("/tasks/my");
});
