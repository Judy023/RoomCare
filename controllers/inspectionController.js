import { pendingRooms, awaitingRepair, listInspections, inspectionContext, recordInspection } from "../services/inspectionService.js";
import { INSPECTION_CHECKLIST } from "../models/enums.js";
import { wrap, toPlain, AppError } from "../utils/http.js";

// Only local paths, so the "back" value cannot send anyone to another site.
const safeBack = (p) => (typeof p === "string" && /^\/(?!\/)[\w\-/?=&%.]*$/.test(p) ? p : "/inspections");

export const inspectionsPage = wrap(async (req, res) => {
  const [pending, waiting, recent] = await Promise.all([pendingRooms(), awaitingRepair(), listInspections()]);
  res.render("inspections/index", {
    title: "Inspections", pending: toPlain(pending), waiting, recent: toPlain(recent), checklist: INSPECTION_CHECKLIST,
  });
});

export const newInspectionPage = wrap(async (req, res) => {
  if (!req.query.roomId) throw new AppError("Choose a room to inspect from the Inspections page.");
  const { room, state, lastTask, resolvedWos } = await inspectionContext(req.query.roomId);
  // ?modal=1 → just the form, loaded into the inspection modal (partials/inspectDialog).
  res.render(req.query.modal === "1" ? "inspections/form" : "inspections/new", {
    back: safeBack(req.query.back),
    title: `Inspect Room ${room.roomNo}`,
    room: toPlain(room), state, lastTask: toPlain(lastTask), resolvedWos: toPlain(resolvedWos),
    checklist: INSPECTION_CHECKLIST,
  });
});

export const createInspection = wrap(async (req, res) => {
  const outcome = await recordInspection(req.body.roomId, req.user, req.body);
  const roomNo = (await outcome.inspection.getRoom()).roomNo;
  if (outcome.result === "PASS") {
    req.flash("success_msg", `Room ${roomNo} passed and is now a Vacant Room.`);
  } else {
    const parts = [`Room ${roomNo} failed inspection.`];
    if (outcome.reopenedTask) parts.push(`${outcome.reopenedTask.code} sent back to the housekeeper.`);
    if (outcome.reopenedWos.length) parts.push(`Reopened ${outcome.reopenedWos.map((w) => w.code).join(", ")}.`);
    if (outcome.needsNewTask) parts.push("Assign a touch-up task from Cleaning Tasks.");
    if (!outcome.reopenedTask && !outcome.reopenedWos.length && !outcome.needsNewTask) parts.push("Report any new fault as a work order.");
    req.flash("error_msg", parts.join(" "));
  }
  res.redirect(safeBack(req.body.back));
});
