import { Op } from "sequelize";
import { InventoryItem } from "../models/index.js";
import { AppError } from "../utils/http.js";
import { logAction } from "./logService.js";
import { notifyRoles } from "./notificationService.js";

export const listItems = () => InventoryItem.findAll({ order: [["category", "ASC"], ["name", "ASC"]] });

// An item counts as low stock when fewer than this many units remain.
export const LOW_STOCK_THRESHOLD = 5;
export const isLowStock = (item) => Number(item.quantity) < LOW_STOCK_THRESHOLD;

export const lowStockItems = () =>
  InventoryItem.findAll({
    where: { quantity: { [Op.lt]: LOW_STOCK_THRESHOLD } },
    order: [["quantity", "ASC"]],
  });

export const getItem = async (id) => {
  const item = await InventoryItem.findByPk(id);
  if (!item) throw new AppError("Inventory item not found", 404);
  return item;
};

// Low-stock alert (the queue worker's job in the deployment diagram).
export const checkLowStock = async (item) => {
  if (!isLowStock(item)) return;
  await notifyRoles("admin", {
    channel: "EMAIL",
    title: `Low stock: ${item.name}`,
    message: `${item.name} (${item.sku}) is down to ${item.quantity} ${item.unit}, below the low-stock limit of ${LOW_STOCK_THRESHOLD}. Supplier: ${item.supplier || "—"}.`,
    link: "/inventory",
  });
};

const parseItem = (data) => {
  const quantity = Number(data.quantity ?? 0);
  const reorderLevel = Number(data.reorderLevel ?? 0);
  const unitCost = Number(data.unitCost ?? 0);
  if (!data.sku?.trim() || !data.name?.trim()) throw new AppError("SKU and name are required.");
  if (![quantity, reorderLevel].every((n) => Number.isInteger(n) && n >= 0)) throw new AppError("Quantity and reorder level must be whole numbers ≥ 0.");
  if (!(unitCost >= 0)) throw new AppError("Unit cost must be ≥ 0.");
  return {
    sku: data.sku.trim(), name: data.name.trim(), category: data.category?.trim() || null, unit: data.unit?.trim() || "pc",
    quantity, reorderLevel, unitCost, supplier: data.supplier?.trim() || null,
  };
};

export const createItem = async (data, userId) => {
  const item = await InventoryItem.create(parseItem(data));
  await logAction(userId, "INVENTORY_CREATE", "InventoryItem", item.id, `${item.sku} ${item.name} (${item.quantity})`);
  return item;
};

export const updateItem = async (id, data, userId) => {
  const item = await getItem(id);
  await item.update(parseItem({ ...data, sku: item.sku }));
  await logAction(userId, "INVENTORY_UPDATE", "InventoryItem", item.id, `${item.sku} → qty ${item.quantity}, reorder ${item.reorderLevel}`);
  await checkLowStock(item);
  return item;
};

export const restock = async (id, qty, userId) => {
  const amount = Number(qty);
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError("Restock quantity must be a whole number above 0.");
  const item = await getItem(id);
  await item.increment("quantity", { by: amount });
  await item.reload();
  await logAction(userId, "INVENTORY_RESTOCK", "InventoryItem", item.id, `${item.sku} +${amount} → ${item.quantity}`);
  return item;
};
