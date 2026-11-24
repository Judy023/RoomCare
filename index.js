/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import { envFileLoaded, checkEnvironment } from "./config/env.js";
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import { sequelize } from "./models/index.js";
import { dbConfigSources } from "./models/db.js";
import { startIntegrationWorker } from "./services/pmsIntegrationService.js";
import { startFrontdeskSyncWorker } from "./services/frontdeskSyncService.js";
import fs from 'fs';
import hbs from "hbs";
import "./helpers/hbs.js";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";
const envCheck = checkEnvironment();
console.log(`⚙️  Environment loaded: NODE_ENV=${process.env.NODE_ENV || "(not set)"}, .env file ${envFileLoaded ? "loaded" : "not used"}`);
// Which variable supplied each database setting (names only, never values), e.g. user=DB_USERNAME, password=DB_PASSWORD.
console.log(`⚙️  Database settings from: ${Object.entries(dbConfigSources).map(([k, v]) => `${k}=${v}`).join(", ")}`);
for (const w of envCheck.warnings) console.warn(`⚠️  Not set: ${w}`);
if (envCheck.required.length) {
  // Thrown, not process.exit(): server.js catches it and keeps answering with a clear 503 instead of dying silently.
  const err = new Error(`Missing required environment variable(s): ${envCheck.required.join(", ")}. Set them in Hostinger hPanel → Node.js app → Environment variables, then restart.`);
  err.code = "MISSING_ENV";
  err.missing = envCheck.required;
  throw err;
}
// Behind Hostinger's HTTPS proxy: needed for secure cookies and correct client IPs.
if (isProd) app.set("trust proxy", 1);

// The FrontDesk webhook is signed over the exact bytes it sends, so keep the raw body for that one route.
app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith("/api/frontdesk/webhook")) req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Startup state, health check and readiness gate ────────────────────────────────────────────────
// `gated` is only switched on by startServer(): code that calls app.listen() itself (the tests) is unaffected.
const startup = { gated: false, dbReady: false, dbError: null, schemaError: null, workers: false, startedAt: new Date() };

// Error code only (e.g. ER_ACCESS_DENIED_ERROR, ECONNREFUSED): useful for diagnosis, never contains credentials.
const errCode = (err) => err?.original?.code || err?.parent?.code || err?.code || err?.name || "UNKNOWN";

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms).unref())]);

app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  let database = startup.dbReady ? "up" : "down";
  let dbError = startup.dbError;
  if (startup.dbReady) {
    try { await withTimeout(sequelize.authenticate(), 3000); } catch (err) { database = "down"; dbError = errCode(err); }
  }
  const ok = database === "up";
  res.status(ok ? 200 : 503).json({
    status: ok ? (startup.schemaError ? "degraded" : "ok") : "unavailable",
    uptimeSeconds: Math.round(process.uptime()),
    database,
    ...(dbError && !ok ? { databaseError: dbError } : {}),
    ...(startup.schemaError ? { schemaError: startup.schemaError } : {}),
    workers: startup.workers ? "running" : "not started",
  });
});

// While the database is not reachable every page would fail anyway: answer with a clear 503 instead of 500s.
app.use((req, res, next) => {
  if (!startup.gated || startup.dbReady) return next();
  res.set("Retry-After", "30");
  if (req.originalUrl.startsWith("/api/")) return res.status(503).json({ error: "Service starting: database not available yet" });
  res.status(503).type("html").send("<!doctype html><meta charset=utf-8><title>RoomCare is starting</title><body style=\"font-family:system-ui;max-width:32rem;margin:15vh auto;text-align:center\"><h1>RoomCare is starting</h1><p>The database is not available yet. This page will work again in a moment — please refresh.</p></body>");
});

app.use(session({
  secret: process.env.SESSION_SECRET || "xianfire-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 12 * 60 * 60 * 1000 }
}));
app.use(flash());

app.engine("xian", async (filePath, options, callback) => {
  try {
     const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});
// Flash messages are read lazily at render time, so a request that only redirects
// (e.g. /dashboard → a role's landing page) does not swallow them.
app.use((req, res, next) => {
  for (const key of ["success_msg", "error_msg"]) {
    Object.defineProperty(res.locals, key, { enumerable: true, configurable: true, get: () => req.flash(key) });
  }
  next();
});


app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
const partialsDir = path.join(__dirname, "views/partials");
fs.readdir(partialsDir, (err, files) => {
  if (err) {
    console.error("❌ Could not read partials directory:", err);
    return;
  }

   files
    .filter(file => file.endsWith('.xian'))
    .forEach(file => {
      const partialName = file.replace('.xian', ''); 
      const fullPath = path.join(partialsDir, file);

      fs.readFile(fullPath, 'utf8', (err, content) => {
        if (err) {
          console.error(`❌ Failed to read partial: ${file}`, err);
          return;
        }
        hbs.registerPartial(partialName, content);
        
      });
    });
});

app.use("/", router);

app.use((req, res) => {
  if (req.originalUrl.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).render("error", { title: "Page not found", message: "The page you were looking for does not exist." });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed" && req.originalUrl.startsWith("/api/")) {
    return res.status(400).json({ success: false, error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
  }
  console.error("❌", err);
  if (req.originalUrl.startsWith("/api/")) return res.status(500).json({ error: "Server error" });
  res.status(500).render("error", { title: "Server error", message: "Something went wrong on our side. Please try again." });
});

export default app;

// Integration workers need the database, so they start once it is ready. Each is isolated: one failing never stops the other.
const startWorkers = () => {
  if (startup.workers) return;
  startup.workers = true;
  for (const [name, start] of [["PMS integration", startIntegrationWorker], ["FrontDeskFlow room sync", startFrontdeskSyncWorker]]) {
    try { start(); } catch (err) { console.error(`❌ ${name} worker could not start:`, err); }
  }
  console.log("✅ Integration workers started");
};

// Connects to MySQL and creates missing tables (sync() without force/alter never drops or changes existing tables or data).
// Retries with backoff until it succeeds; resolves after the FIRST attempt either way.
const DB_RETRY_MAX_MS = 60000;
const connectDatabase = () => new Promise((resolveFirst) => {
  let attempt = 0;
  const tryOnce = async () => {
    attempt++;
    try {
      await sequelize.authenticate();
    } catch (err) {
      const delay = Math.min(5000 * 2 ** (attempt - 1), DB_RETRY_MAX_MS);
      startup.dbError = errCode(err);
      const o = sequelize.config;
      console.error(`❌ Database connection failed (attempt ${attempt}) to ${o.host}:${o.port}/${o.database} as ${o.username}: [${startup.dbError}] ${err.message}. Check DB_HOST / DB_PORT / DB_NAME / DB_USER (or DB_USERNAME) / DB_PASS (or DB_PASSWORD), and that this database user is allowed remote access in hPanel. Retrying in ${delay / 1000}s.`);
      setTimeout(tryOnce, delay);
      return resolveFirst(false);
    }
    try {
      await sequelize.sync();
    } catch (err) {
      // Reachable but table creation failed: existing tables still serve, so keep running and report it loudly.
      startup.schemaError = errCode(err);
      console.error(`❌ Database connected but table sync failed: [${startup.schemaError}] ${err.message}`);
    }
    startup.dbReady = true;
    startup.dbError = null;
    console.log(`✅ Database connected (${sequelize.config.database})`);
    startWorkers();
    resolveFirst(true);
  };
  tryOnce();
});

// Start the HTTP server; resolves once the server is listening and the first database attempt has finished.
// Exported so the Electron main process can control startup itself. Calling it again returns the same server.
// The server listens BEFORE the database is contacted, so the hosting proxy always gets an answer (never a bare 503).
let starting = null;
export const startServer = (port = PORT, host = process.env.HOST) => {
  if (starting) return starting;
  startup.gated = true;
  console.log("🚀 RoomCare startup: opening HTTP server…");
  starting = new Promise((resolve, reject) => {
    const server = app.listen(port, host || undefined);
    server.once("error", (err) => { starting = null; reject(err); });
    server.once("listening", async () => {
      const addr = server.address();
      console.log(`🔥 XianFire listening on ${typeof addr === "string" ? addr : `port ${addr?.port ?? port}`}`);
      await connectDatabase();
      console.log(startup.dbReady ? "✅ RoomCare startup complete" : "⚠️  RoomCare is up but waiting for the database (pages answer 503 until it connects; see /health)");
      resolve(server);
    });
  });
  return starting;
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
