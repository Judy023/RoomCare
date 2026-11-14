
import { sequelize } from "./models/index.js";
import { ensureDatabase, seedDatabase } from "./seed.js";
import inquirer from "inquirer";

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
