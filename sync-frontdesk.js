// Pulls rooms from FrontDeskFlow into RoomCare.
//
//   npm run sync:frontdesk            → GET /housekeeping/rooms  (every room)
//   npm run sync:frontdesk -- 101     → GET /housekeeping/rooms/101  (one room)
//
// Needs FRONTDESK_API_BASE_URL and FRONTDESK_ROOM_MAP in .env (see docs/frontdeskflow-api.md).
import { sequelize } from "./models/index.js";
import { syncAllRooms, syncOneRoom } from "./services/frontdeskSyncService.js";

const roomNumber = process.argv[2];
try {
  const result = roomNumber ? await syncOneRoom(roomNumber, { trigger: "cli" }) : await syncAllRooms({ trigger: "cli" });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.counts?.errors ? 2 : 0;
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
