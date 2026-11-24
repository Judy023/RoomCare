// One-time production setup. Safe to run again: it never drops tables and never overwrites existing users.
//   1. creates any missing tables (sequelize.sync without force)
//   2. creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (set them in .env, run, then remove the password)
//
//   npm run setup:production
//
// Not needed on every deployment: the app itself creates missing tables at startup. Run it once by hand to create the
// first admin — never as a build command.
import { getDatabaseConfig } from "./config/env.js"; // loads .env first
import bcrypt from "bcrypt";

// Same settings and variable names as the app (config/env.js), but always strict: never fall back to root/no password.
const { missing, sources } = getDatabaseConfig({ strict: true });
if (missing.length) {
  console.error(`❌ Setup stopped: database settings not found in the environment: ${missing.join("; ")}.`);
  console.error("   Set them in Hostinger hPanel → Node.js app → Environment variables (or in a .env file next to this script), then run again.");
  process.exit(1);
}
console.log(`⚙️  Database settings from: ${Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(", ")}`);

// Imported only after the check above (static imports would run first).
const { sequelize, User, SystemLog } = await import("./models/index.js");

try {
  await sequelize.authenticate();
  await sequelize.sync();
  console.log("✅ Database connected, tables are in place.");

  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.log("ℹ️  ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin created.");
  } else if (password.length < 10) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters.");
  } else if (await User.findOne({ where: { email } })) {
    console.log(`ℹ️  ${email} already exists: left unchanged.`);
  } else {
    const admin = await User.create({ name: process.env.ADMIN_NAME || "System Admin", email, role: "admin", staffCode: "ADM-001", password: await bcrypt.hash(password, 10) });
    await SystemLog.create({ userId: admin.id, action: "SETUP", entity: "System", details: "First admin created by setup-production" });
    console.log(`✅ Admin created: ${email}. Now remove ADMIN_PASSWORD from .env.`);
  }
} catch (err) {
  console.error("❌ Setup failed:", err.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
