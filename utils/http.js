// A business-rule failure the user can act on (bad input, wrong status, not your task...).
export class AppError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.status = status;
    this.details = details; // optional list of field errors, shown by the /api/integrations responses
  }
}

export const isApi = (req) => req.originalUrl.startsWith("/api/");

const toAppError = (err) => {
  if (err instanceof AppError) return err;
  if (err?.name === "SequelizeUniqueConstraintError" || err?.name === "SequelizeValidationError") {
    return new AppError(err.errors?.[0]?.message || "Invalid data");
  }
  return null;
};

// Express 4 does not catch rejected promises, so every async handler goes through here.
// AppErrors become a flash message + redirect back (form posts), an error page (GETs) or JSON (API).
export const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    const appErr = toAppError(err);
    if (!appErr) return next(err);
    if (isApi(req)) return res.status(appErr.status).json({ error: appErr.message });
    if (req.method === "GET") {
      return res.status(appErr.status).render("error", { title: "Something went wrong", message: appErr.message });
    }
    req.flash("error_msg", appErr.message);
    res.redirect(req.get("Referer") || "/dashboard");
  }
};

// Handlebars refuses to read Sequelize instance getters, so views always get plain objects.
export const toPlain = (value) => {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value.toJSON === "function" && !(value instanceof Date)) return value.toJSON();
  return value;
};

export const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
