import bcrypt from "bcrypt";
import { User } from "../models/index.js";
import { ROLES, SELF_REGISTER_ROLES, ROLE_LABELS } from "../models/enums.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyRoles } from "./notificationService.js";

const SAFE_ATTRIBUTES = { exclude: ["password"] };

export const listUsers = () => User.findAll({ attributes: SAFE_ATTRIBUTES, order: [["role", "ASC"], ["name", "ASC"]] });

export const listStaff = (role) =>
  User.findAll({ where: { role, active: true }, attributes: SAFE_ATTRIBUTES, order: [["name", "ASC"]] });

export const authenticate = async (email, password) => {
  const user = await User.findOne({ where: { email: String(email || "").trim().toLowerCase() } });
  if (!user || !(await bcrypt.compare(password || "", user.password))) throw new AppError("Incorrect email or password.", 401);
  if (!user.active) throw new AppError("This account is awaiting approval or has been deactivated. Contact your System Admin.", 403);
  return user;
};

const profileFields = (data) => ({
  staffCode: data.staffCode?.trim() || null,
  phone: data.phone?.trim() || null,
  shift: ["AM", "PM", "NIGHT"].includes(data.shift) ? data.shift : null,
  floor: data.floor === "" || data.floor == null ? null : Number(data.floor),
  specialty: data.specialty?.trim() || null,
});

export const createUser = async (data, adminId) => {
  if (!data.name?.trim() || !data.email?.trim()) throw new AppError("Name and email are required.");
  if (!ROLES.includes(data.role)) throw new AppError("Choose a valid role.");
  if (!data.password || data.password.length < 8) throw new AppError("Password must be at least 8 characters.");
  const user = await User.create({
    name: data.name.trim(), email: data.email.trim().toLowerCase(), role: data.role,
    password: await bcrypt.hash(data.password, 10), ...profileFields(data),
  });
  await logAction(adminId, "USER_CREATE", "User", user.id, `${user.name} (${user.role})`);
  return user;
};

// Public sign-up: the account starts inactive until a System Admin approves it from Users.
export const registerUser = async (data) => {
  const email = data.email?.trim().toLowerCase();
  if (!data.name?.trim() || !email) throw new AppError("Name and email are required.");
  if (!SELF_REGISTER_ROLES.includes(data.role)) throw new AppError("Choose a valid role.");
  if (!data.password || data.password.length < 8) throw new AppError("Password must be at least 8 characters.");
  if (data.password !== data.confirmPassword) throw new AppError("Passwords do not match.");
  if (await User.findOne({ where: { email } })) throw new AppError("An account with this email already exists.");
  const user = await User.create({
    name: data.name.trim(), email, role: data.role, active: false,
    password: await bcrypt.hash(data.password, 10), ...profileFields({ phone: data.phone }),
  });
  await logAction(user.id, "USER_REGISTER", "User", user.id, `${user.name} (${user.role}) awaiting approval`);
  await notifyRoles("admin", {
    title: "New account awaiting approval",
    message: `${user.name} registered as ${ROLE_LABELS[user.role]}. Tick Active in Users to approve.`,
    link: "/admin/users",
  });
  return user;
};

export const updateUser = async (id, data, adminId) => {
  const user = await User.findByPk(id);
  if (!user) throw new AppError("User not found", 404);
  if (!ROLES.includes(data.role)) throw new AppError("Choose a valid role.");
  const active = data.active === "on" || data.active === true;
  if (user.id === adminId && (!active || data.role !== "admin")) throw new AppError("You cannot deactivate or demote your own admin account.");
  // The password only changes when the admin explicitly chose "Reset"; otherwise it is never touched.
  const resetPassword = data.resetPassword === "1";
  if (resetPassword && (!data.password || data.password.length < 8)) {
    throw new AppError("New password is required and must be at least 8 characters.");
  }
  Object.assign(user, { role: data.role, active, ...profileFields(data) });
  if (resetPassword) user.password = await bcrypt.hash(data.password, 10);
  await user.save();
  await logAction(adminId, "USER_UPDATE", "User", user.id, `${user.name}: ${user.role}, ${active ? "active" : "inactive"}${resetPassword ? ", password reset" : ""}`);
  return user;
};
