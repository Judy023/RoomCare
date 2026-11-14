import { listForUser, markRead, markAllRead } from "../services/notificationService.js";
import { wrap, toPlain } from "../utils/http.js";

export const notificationsPage = wrap(async (req, res) => {
  res.render("notifications/index", { title: "Notifications", notifications: toPlain(await listForUser(req.user.id)) });
});

// Opening a notification marks it read and follows its link.
export const openNotification = wrap(async (req, res) => {
  await markRead(req.user.id, req.params.id);
  const target = req.body.link;
  res.redirect(typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : "/notifications");
});

export const readAllNotifications = wrap(async (req, res) => {
  await markAllRead(req.user.id);
  res.redirect("/notifications");
});
