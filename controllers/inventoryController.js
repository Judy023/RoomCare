import { listItems, createItem, updateItem, restock } from "../services/inventoryService.js";
import { wrap, toPlain } from "../utils/http.js";

export const inventoryPage = wrap(async (req, res) => {
  const items = toPlain(await listItems()).map((i) => ({ ...i, low: i.quantity <= i.reorderLevel }));
  res.render("inventory/index", {
    title: "Inventory & Parts",
    items,
    lowCount: items.filter((i) => i.low).length,
    canEdit: req.user.role === "admin",
  });
});

export const createItemAction = wrap(async (req, res) => {
  const item = await createItem(req.body, req.user.id);
  req.flash("success_msg", `${item.name} added to inventory.`);
  res.redirect("/inventory");
});

export const updateItemAction = wrap(async (req, res) => {
  const item = await updateItem(req.params.id, req.body, req.user.id);
  req.flash("success_msg", `${item.name} updated.`);
  res.redirect("/inventory");
});

export const restockItemAction = wrap(async (req, res) => {
  const item = await restock(req.params.id, req.body.qty, req.user.id);
  req.flash("success_msg", `${item.name} restocked — now ${item.quantity} ${item.unit}.`);
  res.redirect("/inventory");
});
