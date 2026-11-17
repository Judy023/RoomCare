import { board, roomDetail, getRoom, checkOut, checkIn } from "../services/roomService.js";
import { inspectionState } from "../services/inspectionService.js";
import { ADMIN_ROOM_STATUSES } from "../models/enums.js";
import { wrap, toPlain } from "../utils/http.js";

export const boardPage = wrap(async (req, res) => {
  const status = ADMIN_ROOM_STATUSES.includes(req.query.status) ? req.query.status : "";
  const roomBoard = await board(status);
  // Occupied and out-of-order rooms are not shown on the board (nor any floor left empty by that).
  roomBoard.floors = roomBoard.floors
    .map((f) => ({ ...f, rooms: f.rooms.filter((r) => ADMIN_ROOM_STATUSES.includes(r.status)) }))
    .filter((f) => f.rooms.length);
  roomBoard.shown = roomBoard.floors.reduce((n, f) => n + f.rooms.length, 0);
  res.render("rooms/board", {
    title: "Room Status Board",
    board: roomBoard,
    status,
    now: new Date(),
    canCheckInOut: req.user.role === "admin",
  });
});

export const roomPage = wrap(async (req, res) => {
  const room = await roomDetail(req.params.id);
  const role = req.user.role;
  res.render("rooms/show", {
    title: `Room ${room.roomNo}`,
    room: toPlain(room),
    canCheckInOut: role === "admin",
    canAssign: role === "admin",
    canInspect: role === "admin" && (await inspectionState(room)).ok,
  });
});

export const checkOutRoom = wrap(async (req, res) => {
  const room = await checkOut(await getRoom(req.params.id), req.user.id);
  req.flash("success_msg", `Room ${room.roomNo} checked out — admins have been notified to assign cleaning.`);
  res.redirect(req.get("Referer") || "/rooms");
});

export const checkInRoom = wrap(async (req, res) => {
  const room = await checkIn(await getRoom(req.params.id), req.user.id);
  req.flash("success_msg", `Room ${room.roomNo} assigned to the next guest.`);
  res.redirect(req.get("Referer") || "/rooms");
});
