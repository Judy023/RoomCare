// Schema migration for the PMS and HR/Payroll integrations. Only adds things; nothing existing is changed.
//
//   npm run migrate:integrations            → creates integration_events
//                                             adds cleaning_tasks.source / assignedAt / hrExportedAt / hrExportBatch
//                                             adds rooms.pmsStatus / pmsStatusAt
//   npm run migrate:integrations -- --revert → backs up integration_events and the added columns to
//                                             backups/integrations-revert-<timestamp>.json, then removes them
//
// Safe to run more than once. Existing tasks get source = MANUAL and assignedAt = createdAt (the moment they
// were assigned, since every task created before this was assigned on creation).
import fs from "fs/promises";
import path from "path";
import { DataTypes, QueryTypes } from "sequelize";
import { sequelize, IntegrationEvent } from "./models/index.js";
import { TASK_SOURCES } from "./models/enums.js";

const revert = process.argv.includes("--revert");
const qi = sequelize.getQueryInterface();

const COLUMNS = {
  cleaning_tasks: {
    source: { type: DataTypes.ENUM(...TASK_SOURCES), allowNull: false, defaultValue: "MANUAL" },
    assignedAt: { type: DataTypes.DATE, allowNull: true },
    hrExportedAt: { type: DataTypes.DATE, allowNull: true },
    hrExportBatch: { type: DataTypes.STRING(100), allowNull: true },
  },
  Rooms: {
    pmsStatus: { type: DataTypes.STRING(40), allowNull: true },
    pmsStatusAt: { type: DataTypes.DATE, allowNull: true },
  },
};

const tableExists = async (table) =>
  (await sequelize.query("SHOW TABLES LIKE :table", { replacements: { table }, type: QueryTypes.SELECT })).length > 0;

// Resolves the real table name (MySQL on Windows lower-cases names, Linux does not).
const realTable = async (name) => {
  const rows = await sequelize.query(
    "SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(:name)",
    { replacements: { name }, type: QueryTypes.SELECT }
  );
  if (!rows.length) throw new Error(`Table ${name} not found — run npm run migrate first.`);
  return rows[0].t;
};

const migrate = async () => {
  await IntegrationEvent.sync();
  console.log("✅ integration_events table ready");

  for (const [name, columns] of Object.entries(COLUMNS)) {
    const table = await realTable(name);
    const existing = await qi.describeTable(table);
    for (const [column, spec] of Object.entries(columns)) {
      if (existing[column]) {
        console.log(`ℹ️  ${table}.${column} already exists`);
        continue;
      }
      await qi.addColumn(table, column, spec);
      console.log(`✅ ${table}.${column} added`);
    }
  }

  const tasks = await realTable("cleaning_tasks");
  const [, meta] = await sequelize.query(`UPDATE \`${tasks}\` SET assignedAt = createdAt WHERE assignedAt IS NULL AND housekeeperId IS NOT NULL`);
  console.log(`✅ assignedAt filled in for ${meta?.affectedRows ?? 0} existing task(s)`);
};

const rollback = async () => {
  const backup = { takenAt: new Date().toISOString(), integration_events: [], columns: {} };
  if (await tableExists("integration_events")) {
    backup.integration_events = await sequelize.query("SELECT * FROM integration_events", { type: QueryTypes.SELECT });
  }
  for (const [name, columns] of Object.entries(COLUMNS)) {
    const table = await realTable(name);
    const existing = await qi.describeTable(table);
    const present = Object.keys(columns).filter((c) => existing[c]);
    if (present.length) {
      backup.columns[table] = await sequelize.query(`SELECT id, ${present.map((c) => `\`${c}\``).join(", ")} FROM \`${table}\``, { type: QueryTypes.SELECT });
    }
  }
  const file = path.join(process.cwd(), "backups", `integrations-revert-${Date.now()}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(backup, null, 2));
  console.log(`💾 Backup written: ${file}`);

  for (const [name, columns] of Object.entries(COLUMNS)) {
    const table = await realTable(name);
    const existing = await qi.describeTable(table);
    for (const column of Object.keys(columns)) {
      if (!existing[column]) continue;
      await qi.removeColumn(table, column);
      console.log(`✅ ${table}.${column} removed`);
    }
  }
  if (await tableExists("integration_events")) {
    await qi.dropTable("integration_events");
    console.log("✅ integration_events dropped");
  }
  console.log("Also revert the code changes (git) so the app stops using these columns.");
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
