// Production entry point (Hostinger "Startup file"). index.js only auto-starts when run as `node index.js`,
// which is not how hosting launchers start an app, so this file starts the server explicitly.
import { startServer } from "./index.js";

startServer(process.env.PORT || 3000).catch((err) => {
  console.error("❌ Could not start RoomCare:", err);
  process.exit(1);
});
