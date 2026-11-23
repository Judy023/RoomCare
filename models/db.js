
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

import "../config/env.js";
import { Sequelize } from "sequelize";

// DB_* names are ours; DATABASE_* are the names Hostinger's panel creates. Either works.
const env = process.env;
export const DB_NAME = env.DB_NAME || env.DATABASE_NAME || "RoomCare";

export const sequelize = new Sequelize(DB_NAME, env.DB_USER || env.DATABASE_USERNAME || "root", env.DB_PASS ?? env.DATABASE_PASSWORD ?? "", {
  host: env.DB_HOST || env.DATABASE_HOST || "localhost",
  port: Number(env.DB_PORT || env.DATABASE_PORT) || 3306,
  dialect: "mysql",
  logging: false
});
