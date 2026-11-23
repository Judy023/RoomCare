// One-time production setup. Safe to run again: it never drops tables and never overwrites existing users.
//   1. creates any missing tables (sequelize.sync without force)
//   2. creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (set them in .env, run, then remove the password)
//
//   npm run setup:production
import bcrypt from "bcrypt";
import { sequelize, User, SystemLog } from "./models/index.js";
import "./config/env.js";

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
