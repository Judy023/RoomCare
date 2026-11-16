// One-time schema migration: renames the leftover supervisorId columns to adminId.
//
//   npm run migrate:rename-supervisor-columns            → cleaning_tasks.supervisorId → adminId
//                                                          inspections.supervisorId    → adminId
//   npm run migrate:rename-supervisor-columns -- --revert → renames them back to supervisorId
//
// Safe to run more than once. Data is not touched: MySQL keeps every value and the foreign keys
// to users(id) when a column is renamed. The matching index is renamed as well.
import { QueryTypes } from "sequelize";
import { sequelize } from "./models/index.js";

const TABLES = ["cleaning_tasks", "inspections"];
const revert = process.argv.includes("--revert");
const [from, to] = revert ? ["adminId", "supervisorId"] : ["supervisorId", "adminId"];

const hasColumn = async (table, column) =>
  (await sequelize.query(`SHOW COLUMNS FROM \`${table}\` LIKE :column`, { replacements: { column }, type: QueryTypes.SELECT })).length > 0;

const hasIndex = async (table, index) =>
  (await sequelize.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = :index`, { replacements: { index }, type: QueryTypes.SELECT })).length > 0;

const run = async () => {
  for (const table of TABLES) {
    if (await hasColumn(table, from)) {
      await sequelize.query(`ALTER TABLE \`${table}\` RENAME COLUMN \`${from}\` TO \`${to}\``);
      console.log(`✅ ${table}.${from} → ${to}`);
    } else {
      console.log(`ℹ️  ${table}.${from} not found (already ${(await hasColumn(table, to)) ? to : "missing"})`);
    }
    if ((await hasIndex(table, from)) && !(await hasIndex(table, to))) {
      await sequelize.query(`ALTER TABLE \`${table}\` RENAME INDEX \`${from}\` TO \`${to}\``);
      console.log(`✅ ${table} index ${from} → ${to}`);
    }
  }
  if (revert) console.log("Also revert the code changes (git) so the app uses supervisorId again.");
};

try {
  await sequelize.authenticate();
  await run();
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
