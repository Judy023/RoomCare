// Production entry point (Hostinger "Entry file"). index.js only auto-starts when run as `node index.js`,
// which is not how hosting launchers start an app, so this file starts the server explicitly.
//
// Hostinger's LiteSpeed launcher (lsnode.js) loads this file with require(). Node refuses to require() an
// ES module whose import graph contains top-level await (ERR_REQUIRE_ASYNC_MODULE), so this file has no
// static imports and loads the app with a dynamic import() instead, which works from any loader.
//
// If the app cannot load (missing SESSION_SECRET, a broken dependency, …) the process does NOT exit: exiting
// makes the proxy show a bare "503 Service Unavailable" with no reason. Instead a minimal server answers every
// request with a 503 page and GET /health says what failed. The full error is in the runtime log.
const port = process.env.PORT || 3000;
console.log(`🚀 RoomCare initialization started (Node ${process.version}, pid ${process.pid})`);

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled promise rejection (server keeps running):", reason);
});
process.on("uncaughtException", (err) => {
  // State is unknown after this; exit so the host restarts a clean process on the next request.
  console.error("❌ Uncaught exception, exiting:", err);
  process.exit(1);
});

const serveStartupFailure = async (err) => {
  const { createServer } = await import("node:http");
  const info = { status: "error", stage: "startup", error: err?.code || err?.name || "UNKNOWN", ...(err?.missing ? { missing: err.missing } : {}) };
  createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(info));
    }
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Retry-After": "60" });
    res.end("<!doctype html><title>RoomCare unavailable</title><body style=\"font-family:system-ui;max-width:32rem;margin:15vh auto;text-align:center\"><h1>RoomCare could not start</h1><p>The administrator has been notified in the server log. Please try again later.</p></body>");
  }).listen(port, () => console.error(`⚠️  RoomCare failed to start; serving a 503 page and /health on port ${port} until it is fixed and restarted.`));
};

import("./index.js")
  .then(({ startServer }) => startServer(port))
  .catch((err) => {
    if (err?.syscall === "listen") {
      // The port itself is unusable, so a fallback server could not listen either.
      console.error(`❌ Could not listen on port ${port}:`, err.message);
      process.exit(1);
    }
    console.error("❌ Could not start RoomCare:", err?.code === "MISSING_ENV" ? err.message : err);
    serveStartupFailure(err).catch((e) => { console.error("❌ Fallback server failed:", e); process.exit(1); });
  });
