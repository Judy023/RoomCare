
import { sequelize } from "./models/index.js";
import { ensureDatabase, seedDatabase, assertNotProduction } from "./seed.js";
import inquirer from "inquirer";

// This script recreates every table (sync force). Stop before asking anything when run against production.
try { assertNotProduction("npm run migrate"); } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }

const { createDb, seed } = await inquirer.prompt([
  {
    type: "confirm",
    name: "createDb",
    message: "Database 'RoomCare' may not exist. Create it?",
    default: true,
  },
  {
    type: "confirm",
    name: "seed",
    message: "Load the RoomCare demo data (users, rooms, tasks, work orders, inventory)?",
    default: true,
  },
]);

if (createDb) {
  await ensureDatabase();
  console.log("✅ Database created (if it did not exist)");
}

try {
  await sequelize.authenticate();
  console.log("✅ Connected to MySQL database!");
  if (seed) {
    console.log("✅ Tables created; users and inventory loaded:", await seedDatabase());
  } else {
    await sequelize.sync({ force: true });
    console.log("✅ Tables created for all models!");
  }
} catch (err) {
  console.error("❌ Migration failed:", err);
} finally {
  process.exit();
}
