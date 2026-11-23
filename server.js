// Production entry point (Hostinger "Startup file"). index.js only auto-starts when run as `node index.js`,
// which is not how hosting launchers start an app, so this file starts the server explicitly.
//
// Hostinger's LiteSpeed launcher (lsnode.js) loads this file with require(). Node refuses to require() an
// ES module whose import graph contains top-level await (ERR_REQUIRE_ASYNC_MODULE), so this file has no
// static imports and loads the app with a dynamic import() instead, which works from any loader.
import("./index.js")
  .then(({ startServer }) => startServer(process.env.PORT || 3000))
  .catch((err) => {
    console.error("❌ Could not start RoomCare:", err);
    process.exit(1);
  });
