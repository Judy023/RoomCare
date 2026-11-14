import { Notification, User } from "../models/index.js";

// Outbound providers are stubs that log to the console. Swap them for a real SMS gateway,
// Nodemailer/Resend and web-push when the hotel has accounts with those providers.
const providers = {
  SMS: (user, n) => console.log(`📱 SMS → ${user.phone || "(no phone)"} [${user.name}]: ${n.message}`),
  EMAIL: (user, n) => console.log(`✉️  Email → ${user.email}: ${n.title} — ${n.message}`),
  PUSH: (user, n) => console.log(`🔔 Push → ${user.name}: ${n.title}`),
  IN_APP: () => {},
};

export const notifyUser = async (userOrId, { channel = "IN_APP", title, message, link = null }) => {
  const user = typeof userOrId === "object" && userOrId ? userOrId : await User.findByPk(userOrId);
  if (!user) return null;
  const notification = await Notification.create({ recipientId: user.id, channel, title, message, link, sentAt: new Date() });
  try {
    providers[channel]?.(user, notification);
  } catch (err) {
    console.error(`❌ ${channel} delivery failed:`, err.message);
  }
  return notification;
};

export const notifyRoles = async (roles, payload) => {
  const users = await User.findAll({ where: { role: [].concat(roles), active: true } });
  return Promise.all(users.map((user) => notifyUser(user, payload)));
};

export const listForUser = (userId, limit = 100) =>
  Notification.findAll({ where: { recipientId: userId }, order: [["createdAt", "DESC"]], limit });

export const unreadCount = (userId) => Notification.count({ where: { recipientId: userId, isRead: false } });

export const markRead = (userId, id) => Notification.update({ isRead: true }, { where: { id, recipientId: userId } });

export const markAllRead = (userId) =>
  Notification.update({ isRead: true }, { where: { recipientId: userId, isRead: false } });
