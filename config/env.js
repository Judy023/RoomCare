// Loads an optional .env file (KEY=value lines) into process.env before anything reads it.
// Real environment variables always win; a missing .env is fine. Never commit .env — see .env.example.
// On Hostinger, variables set in hPanel are real environment variables, so no .env file is needed there.
export let envFileLoaded = false;
try {
  process.loadEnvFile?.();
  envFileLoaded = Boolean(process.loadEnvFile);
} catch {
  // no .env file
}

const has = (...names) => names.some((n) => String(process.env[n] ?? "").trim() !== "");

// ── Database settings: the ONE place every script (app, setup, seed, migrations) reads them ──────────
// Each setting accepts several names because panels differ: DB_USER is ours, Hostinger's Node.js panel commonly
// uses DB_USERNAME / DB_PASSWORD, and some hosts use DATABASE_*. The first non-empty name wins.
export const DB_VARS = {
  host: ["DB_HOST", "DATABASE_HOST"],
  port: ["DB_PORT", "DATABASE_PORT"],
  database: ["DB_NAME", "DB_DATABASE", "DATABASE_NAME"],
  username: ["DB_USER", "DB_USERNAME", "DATABASE_USER", "DATABASE_USERNAME"],
  password: ["DB_PASS", "DB_PASSWORD", "DATABASE_PASSWORD", "DATABASE_PASS"],
};
// Local development defaults only. In production nothing falls back: a missing setting is reported by name instead
// of silently connecting as root with no password.
const DB_DEV_DEFAULTS = { host: "localhost", port: "3306", database: "RoomCare", username: "root", password: "" };

// Passwords are used exactly as given (spaces can be part of them); other values are trimmed.
const firstSet = (names, trim) => {
  for (const n of names) {
    const v = String(process.env[n] ?? "");
    if (v.trim() !== "") return { name: n, value: trim ? v.trim() : v };
  }
  return null;
};

// Returns the Sequelize settings plus `missing` (the variable names to set) and `sources` (which variable supplied
// each setting). Never logs anything; callers must not print `password`.
// `strict` (default: in production) disables the local defaults.
export const getDatabaseConfig = ({ strict } = {}) => {
  const isProd = strict ?? process.env.NODE_ENV === "production";
  const config = { dialect: "mysql" };
  const missing = [];
  const sources = {};
  for (const [key, names] of Object.entries(DB_VARS)) {
    const found = firstSet(names, key !== "password");
    if (found) { config[key] = found.value; sources[key] = found.name; continue; }
    // Port has a universal default; everything else must be given explicitly in production.
    if (isProd && key !== "port") {
      missing.push(`${names[0]} (or ${names.slice(1).join(" / ")})`);
      config[key] = undefined; // no root/empty-password value ever exists in production
      sources[key] = "missing";
    } else {
      config[key] = DB_DEV_DEFAULTS[key];
      sources[key] = "default";
    }
  }
  config.port = Number(config.port) || 3306;
  return { ...config, missing, sources, isProd };
};

// Names (never values) of settings that are missing. `required` stops the app from serving; `warnings` only limit features.
export const checkEnvironment = () => {
  const isProd = process.env.NODE_ENV === "production";
  const required = [];
  const warnings = [];
  if (isProd && !has("SESSION_SECRET")) required.push("SESSION_SECRET");
  if (isProd) required.push(...getDatabaseConfig().missing);
  if (isProd) {
    if (!has("FRONTDESK_API_KEY", "PMS_WEBHOOK_TOKEN")) warnings.push("FRONTDESK_API_KEY (FrontDeskFlow → RoomCare calls are refused until set)");
    if (!has("STAFFPAY_API_KEY", "HR_API_TOKEN")) warnings.push("STAFFPAY_API_KEY (StaffPay → RoomCare calls are refused until set)");
  }
  if (String(process.env.PMS_MODE).toLowerCase() === "live") {
    for (const n of ["FRONTDESK_API_BASE_URL", "FRONTDESK_API_TOKEN", "FRONTDESK_API_SIGNING_SECRET", "FRONTDESK_WEBHOOK_SECRET"]) {
      if (!has(n)) warnings.push(`${n} (needed by the live FrontDeskFlow connection)`);
    }
  }
  return { isProd, required, warnings };
};
