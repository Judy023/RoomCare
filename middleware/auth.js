import { User } from "../models/index.js";
import { isApi } from "../utils/http.js";
import { unreadCount } from "../services/notificationService.js";

const NAV = [
  { href: "/dashboard", label: "Overview", roles: ["supervisor", "admin"] },
  { href: "/tasks/my", label: "My Tasks", roles: ["housekeeper"] },
  { href: "/work-orders/my", label: "My Work Orders", roles: ["technician"] },
  { href: "/rooms", label: "Room Board", roles: ["supervisor", "admin"] },
  { href: "/tasks", label: "Cleaning Tasks", roles: ["supervisor", "admin"] },
  { href: "/work-orders", label: "Work Orders", roles: ["supervisor", "admin", "technician"] },
  { href: "/work-orders/new", label: "Report Issue", roles: ["housekeeper", "technician", "supervisor"] },
  { href: "/inspections", label: "Inspections", roles: ["supervisor", "admin"] },
  { href: "/inventory", label: "Inventory", roles: ["supervisor", "technician", "admin"] },
  { href: "/reports", label: "Reports", roles: ["admin"] },
  { href: "/admin/users", label: "Users", roles: ["admin"] },
  { href: "/admin/rooms", label: "Rooms", roles: ["admin"] },
  { href: "/admin/logs", label: "System Logs", roles: ["admin"] },
];

export const LANDING = {
  housekeeper: "/tasks/my",
  technician: "/work-orders/my",
  supervisor: "/dashboard",
  admin: "/dashboard",
};

const buildNav = (role, path) => {
  const links = NAV.filter((l) => l.roles.includes(role));
  const active = links
    .filter((l) => path === l.href || path.startsWith(l.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return links.map((l) => ({ href: l.href, label: l.label, active: l === active }));
};

// Loads the signed-in user (if any) for every request and exposes it to the views.
export const loadUser = async (req, res, next) => {
  try {
    if (req.session.userId) {
      const user = await User.findByPk(req.session.userId, { attributes: { exclude: ["password"] } });
      if (user?.active) {
        req.user = user;
        res.locals.currentUser = user.toJSON();
        res.locals.navLinks = buildNav(user.role, req.path);
        res.locals.unreadCount = await unreadCount(user.id);
      } else {
        req.session.userId = null;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (req, res, next) => {
  if (req.user) return next();
  if (isApi(req)) return res.status(401).json({ error: "Not signed in" });
  res.redirect("/login");
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return requireAuth(req, res, next);
  if (roles.includes(req.user.role)) return next();
  if (isApi(req)) return res.status(403).json({ error: "Forbidden for your role" });
  res.status(403).render("error", { title: "Access denied", message: "Your role does not have access to this page." });
};
