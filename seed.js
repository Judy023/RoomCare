// Recreates every RoomCare table and loads the starting staff accounts and inventory.
// Rooms, tasks, work orders, inspections and notifications start empty — add rooms from Admin → Rooms.
//
//   npm run seed        (WARNING: drops and recreates all tables)
import bcrypt from "bcrypt";
import { Sequelize } from "sequelize";
import { pathToFileURL } from "url";
import { getDatabaseConfig } from "./config/env.js";
import { DB_NAME } from "./models/db.js";
import { sequelize, User, InventoryItem, SystemLog } from "./models/index.js";

const DEMO_PASSWORD = "password123";

// Seeding drops every table. Refuse in production so live data can never be wiped by a stray `npm run seed`/`migrate`.
export const assertNotProduction = (what) => {
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${what} drops and recreates all tables and is disabled when NODE_ENV=production. Use "npm run setup:production" instead (it never deletes data).`);
  }
};

export const ensureDatabase = async () => {
  const { username, password, host, port, dialect } = getDatabaseConfig();
  const server = new Sequelize("", username, password, { host, port, dialect, logging: false });
  await server.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
  await server.close();
};

export const seedDatabase = async () => {
  assertNotProduction("Seeding");
  await sequelize.sync({ force: true });
  const password = await bcrypt.hash(DEMO_PASSWORD, 10);

  // ── Users ────────────────────────────────────────────────────────────────
  const mkUser = (name, email, role, extra = {}) => User.create({ name, email, role, password, ...extra });
  const admin = await mkUser("System Admin", "admin@roomcare.local", "admin", { staffCode: "ADM-001" });
  await mkUser("Liza Mendoza", "liza.mendoza@roomcare.local", "admin", { staffCode: "ADM-004", shift: "AM", phone: "+63 917 555 0104" });
  await mkUser("Mark Reyes", "mark.reyes@roomcare.local", "admin", { staffCode: "ADM-005", shift: "PM", phone: "+63 917 555 0105" });
  await mkUser("Carlo Dizon", "carlo.dizon@roomcare.local", "housekeeper", { staffCode: "HK-021", shift: "AM", floor: 3, phone: "+63 917 555 0121" });
  await mkUser("Ana Santos", "ana.santos@roomcare.local", "housekeeper", { staffCode: "HK-022", shift: "AM", floor: 2, phone: "+63 917 555 0122" });
  await mkUser("Jerome Cruz", "jerome.cruz@roomcare.local", "housekeeper", { staffCode: "HK-023", shift: "AM", floor: 1, phone: "+63 917 555 0123" });
  await mkUser("Bea Garcia", "bea.garcia@roomcare.local", "housekeeper", { staffCode: "HK-024", shift: "PM", floor: 4, phone: "+63 917 555 0124" });
  await mkUser("Ramon Bautista", "ramon.bautista@roomcare.local", "technician", { staffCode: "TEC-007", specialty: "HVAC", phone: "+63 917 555 0107" });
  await mkUser("Joel Ramos", "joel.ramos@roomcare.local", "technician", { staffCode: "TEC-008", specialty: "Plumbing & Electrical", phone: "+63 917 555 0108" });

  // ── Inventory ────────────────────────────────────────────────────────────
  const mkItem = (sku, name, category, unit, quantity, reorderLevel, unitCost, supplier) =>
    InventoryItem.create({ sku, name, category, unit, quantity, reorderLevel, unitCost, supplier });
  await mkItem("HVAC-CAP-35", "Run capacitor 35µF", "HVAC", "pc", 4, 5, 450, "CoolTech Supply");
  await mkItem("HVAC-FLT-01", "Aircon filter (split type)", "HVAC", "pc", 18, 6, 220, "CoolTech Supply");
  await mkItem("HVAC-R32", "R32 refrigerant", "HVAC", "kg", 6, 4, 980, "CoolTech Supply");
  await mkItem("PLB-FLAP-02", "Toilet flapper valve", "Plumbing", "pc", 9, 4, 160, "Metro Hardware");
  await mkItem("PLB-CART-40", "Faucet cartridge 40mm", "Plumbing", "pc", 3, 4, 640, "Metro Hardware");
  await mkItem("PLB-SHWR-01", "Shower head", "Plumbing", "pc", 7, 3, 850, "Metro Hardware");
  await mkItem("ELC-LED-09", "LED bulb 9W warm white", "Electrical", "pc", 64, 20, 95, "Bright Electrical");
  await mkItem("ELC-KEYSW", "Key-card power switch", "Electrical", "pc", 5, 2, 1250, "Bright Electrical");
  await mkItem("FRN-HINGE", "Cabinet hinge (soft-close)", "Furniture", "pc", 22, 10, 120, "Metro Hardware");
  await mkItem("PNT-WHT-1L", "Wall paint, white (1 L)", "Painting", "can", 4, 2, 520, "Metro Hardware");
  await mkItem("APL-REMOTE", "Universal TV remote", "Appliance", "pc", 2, 3, 380, "Bright Electrical");

  await SystemLog.create({ userId: admin.id, action: "SEED", entity: "System", details: "Users and inventory loaded" });

  return { users: await User.count(), items: await InventoryItem.count() };
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    assertNotProduction("npm run seed");
    await ensureDatabase();
    const counts = await seedDatabase();
    console.log("✅ RoomCare users and inventory loaded:", counts);
    console.log(`🔑 Every account uses the password "${DEMO_PASSWORD}" (e.g. liza.mendoza@roomcare.local).`);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}
