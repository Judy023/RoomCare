import { kpis, workOrdersCsv } from "../services/reportService.js";
import { wrap } from "../utils/http.js";

const PERIODS = [7, 30, 90];
const periodFrom = (query) => (PERIODS.includes(Number(query.days)) ? Number(query.days) : 30);

export const reportsPage = wrap(async (req, res) => {
  const days = periodFrom(req.query);
  res.render("reports/index", { title: "Reports & KPI Dashboard", report: await kpis(days), periods: PERIODS, days });
});

export const workOrdersCsvExport = wrap(async (req, res) => {
  const days = periodFrom(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="roomcare-work-orders-${days}d.csv"`);
  res.send(await workOrdersCsv(days));
});
