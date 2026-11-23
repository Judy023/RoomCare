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
    
import "./config/env.js";
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
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
if (isProd && !process.env.SESSION_SECRET) {
  console.error("❌ SESSION_SECRET must be set when NODE_ENV=production.");
  process.exit(1);
}
// Behind Hostinger's HTTPS proxy: needed for secure cookies and correct client IPs.
if (isProd) app.set("trust proxy", 1);

// The FrontDesk webhook is signed over the exact bytes it sends, so keep the raw body for that one route.
app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith("/api/frontdesk/webhook")) req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));

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

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = (port = PORT) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 XianFire running at http://localhost:${port}`);
      startIntegrationWorker();
      startFrontdeskSyncWorker();
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
