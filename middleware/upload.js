import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

// Issue and inspection photos. Stored on local disk (public/uploads) in place of S3 for this deployment.
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

export const uploadPhoto = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype])),
}).single("photo");

// Turns multer errors (e.g. file too large) into a flash message instead of a crash page.
export const handlePhotoUpload = (req, res, next) =>
  uploadPhoto(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Photo must be 5 MB or smaller." : `Upload failed: ${err.message}`;
    if (req.originalUrl.startsWith("/api/")) return res.status(400).json({ error: message });
    req.flash("error_msg", message);
    res.redirect(req.get("Referer") || "/work-orders/new");
  });
