
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

// config/env.js must be the first import: ES modules evaluate their imports in order, depth-first, so this loads
// .env (when present) before the Sequelize instance below is created, no matter which file imports the models.
import { getDatabaseConfig, checkEnvironment } from "../config/env.js";
import { Sequelize } from "sequelize";

// Variable names accepted for each setting are listed in config/env.js (DB_USER or DB_USERNAME, DB_PASS or DB_PASSWORD, …).
const db = getDatabaseConfig();
if (db.missing.length) {
  // Production only (development has local defaults). Never connect as root/no password by accident.
  // Report every missing required variable (e.g. SESSION_SECRET too), since index.js's own check never runs after this.
  const missing = checkEnvironment().required;
  const err = new Error(`Missing required environment variable(s): ${missing.join("; ")}. Set them in Hostinger hPanel → Node.js app → Environment variables, then restart.`);
  err.code = "MISSING_ENV";
  err.missing = missing;
  throw err;
}

export const DB_NAME = db.database;
export const dbConfigSources = db.sources;

export const sequelize = new Sequelize(db.database, db.username, db.password, {
  host: db.host,
  port: db.port,
  dialect: db.dialect,
  logging: false
});
