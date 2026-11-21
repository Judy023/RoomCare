import express from "express";
import { integrationGuard } from "../middleware/integrationAuth.js";
import { errorBody } from "../middleware/integrationAuth.js";
import * as c from "../controllers/integrationController.js";

// /api/integrations/* — system-to-system API. Authenticated by API key (not a user session); see docs/integration-api.md.
const router = express.Router();

const frontdesk = express.Router();
frontdesk.use(integrationGuard("frontdesk"));
// FrontDeskFlow → RoomCare
frontdesk.post("/rooms", c.frontdeskCreateRoom);
frontdesk.get("/rooms", c.frontdeskListRooms);
frontdesk.get("/rooms/:externalRoomId", c.frontdeskGetRoom);
frontdesk.put("/rooms/:externalRoomId", c.frontdeskUpdateRoom);
frontdesk.post("/checkout", c.frontdeskCheckout);
// RoomCare → FrontDeskFlow (FrontDeskFlow reads these; the push side is configured in config/integrations.js)
frontdesk.get("/room-status-updates", c.frontdeskStatusUpdates);
frontdesk.get("/cleaned-rooms", c.frontdeskCleanedRooms);

const staffpay = express.Router();
staffpay.use(integrationGuard("staffpay"));
staffpay.get("/employees/:employeeId/job-logs", c.staffpayEmployeeJobLogs);
staffpay.get("/job-logs", c.staffpayJobLogs);
staffpay.get("/work-hours", c.staffpayWorkHours);
staffpay.get("/overtime", c.staffpayOvertime);
staffpay.get("/performance", c.staffpayPerformance);

router.use("/frontdesk", frontdesk);
router.use("/staffpay", staffpay);
router.use((req, res) => res.status(404).json(errorBody(404, "NOT_FOUND", "Unknown integration endpoint")));

export default router;
