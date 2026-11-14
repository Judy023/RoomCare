
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

import { sequelize } from "../models/index.js";
import { authenticate, registerUser as registerAccount } from "../services/userService.js";
import { SELF_REGISTER_ROLES } from "../models/enums.js";
import { logAction } from "../services/logService.js";
import { wrap } from "../utils/http.js";
await sequelize.sync();


export const loginPage = (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("login", { title: "Login" });
};
export const registerPage = (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("register", { title: "Create Account", roles: SELF_REGISTER_ROLES });
};

export const registerUser = wrap(async (req, res) => {
  await registerAccount(req.body);
  req.flash("success_msg", "Account created. A System Admin needs to approve it before you can sign in.");
  res.redirect("/login");
});
export const forgotPasswordPage = (req, res) => res.render("forgotpassword", { title: "Forgot Password" });

export const loginUser = wrap(async (req, res) => {
  const user = await authenticate(req.body.email, req.body.password);
  req.session.userId = user.id;
  await logAction(user.id, "LOGIN", "User", user.id, user.email);
  res.redirect("/dashboard");
});

export const logoutUser = (req, res) => {
  req.session.destroy();
  res.redirect("/login");
};
