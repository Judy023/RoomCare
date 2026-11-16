// One-time data migration: removes the Supervisor role from an existing RoomCare database.
//
//   npm run migrate:remove-supervisor            → converts every "supervisor" user to "admin",
//                                                  then drops "supervisor" from the Users.role ENUM
//   npm run migrate:remove-supervisor -- --revert → puts "supervisor" back in the ENUM and restores
//                                                  the converted users from the backup file
//
// Safe to run more than once. Before changing anything it writes the affected users to
// backups/supervisor-role-backup.json so the change can be undone. No rows are deleted, and
// existing tasks/inspections keep their supervisorId links (those now point at admin accounts).
import fs from "fs/promises";
import path from "path";
import { DataTypes, QueryTypes } from "sequelize";
import { sequelize, User } from "./models/index.js";
import { ROLES } from "./models/enums.js";
import { logAction } from "./services/logService.js";

const BACKUP_FILE = path.join(process.cwd(), "backups", "supervisor-role-backup.json");
const LEGACY_ROLES = ["housekeeper", "supervisor", "technician", "admin"];
const revert = process.argv.includes("--revert");

const table = User.getTableName();
const qi = sequelize.getQueryInterface();
const setRoleEnum = (values) =>
  qi.changeColumn(table, "role", { type: DataTypes.ENUM(...values), allowNull: false, defaultValue: "housekeeper" });

const readBackup = async () => {
  try {
    return JSON.parse(await fs.readFile(BACKUP_FILE, "utf-8"));
  } catch {
    return { users: [] };
  }
};

// Current ENUM values of Users.role, e.g. "enum('a','b')" → ["a", "b"].
const currentRoleEnum = async () => {
  const [col] = await sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE 'role'`, { type: QueryTypes.SELECT });
  return [...String(col?.Type || "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
};

const migrate = async () => {
  const supervisors = await sequelize.query(
    `SELECT id, name, email, staffCode FROM \`${table}\` WHERE role = 'supervisor'`,
    { type: QueryTypes.SELECT }
  );

  // Keep users and the original column definition from any earlier run so --revert restores all of it.
  const backup = await readBackup();
  backup.originalRoleEnum ??= await currentRoleEnum();
  const known = new Set(backup.users.map((u) => u.id));
  backup.users.push(...supervisors.filter((u) => !known.has(u.id)));
  backup.migratedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(BACKUP_FILE), { recursive: true });
  await fs.writeFile(BACKUP_FILE, JSON.stringify(backup, null, 2));
  console.log(`💾 Backup written: ${BACKUP_FILE}`);

  if (supervisors.length) {
    await sequelize.query(`UPDATE \`${table}\` SET role = 'admin' WHERE role = 'supervisor'`);
    for (const u of supervisors) {
      await logAction(null, "ROLE_MIGRATE", "User", u.id, `${u.name}: supervisor → admin (Supervisor role removed)`);
      console.log(`   ${u.name} <${u.email}> → admin`);
    }
    console.log(`✅ ${supervisors.length} supervisor account(s) converted to admin`);
  } else {
    console.log("ℹ️  No supervisor accounts found");
  }

  await setRoleEnum(ROLES);
  console.log(`✅ Users.role now allows: ${ROLES.join(", ")}`);
};

const rollback = async () => {
  const { users, originalRoleEnum } = await readBackup();
  const values = originalRoleEnum?.length ? originalRoleEnum : LEGACY_ROLES;
  await setRoleEnum(values);
  console.log(`✅ Users.role allows: ${values.join(", ")}`);

  if (!users.length) return console.log("ℹ️  No backup entries — no users to restore");
  const ids = users.map((u) => u.id);
  await sequelize.query(`UPDATE \`${table}\` SET role = 'supervisor' WHERE role = 'admin' AND id IN (:ids)`, { replacements: { ids } });
  for (const u of users) await logAction(null, "ROLE_MIGRATE", "User", u.id, `${u.name}: admin → supervisor (rollback)`);
  console.log(`✅ Restored ${users.length} supervisor account(s). Also revert the code changes (git) to use the role again.`);
};

try {
  await sequelize.authenticate();
  await (revert ? rollback() : migrate());
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
