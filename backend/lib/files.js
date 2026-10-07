import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", ".."); // backend/lib → project root
const TMP_DIR = path.join(ROOT, "tmp");

fs.mkdirSync(TMP_DIR, { recursive: true });

// Uploaded files land here first ("multer saves to a temp path"), then get
// copied into /library at generation time.
const storage = multer.diskStorage({
  destination: TMP_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image uploads are allowed"));
  },
});

export function libraryDir(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return path.join(ROOT, "library", `${y}-${m}-${d}`);
}

/**
 * Persist a file into library/YYYY-MM-DD/ under destName.
 * src may be a path (copied from the tmp upload) or a Buffer (generated output).
 * Returns both the library-relative path (for the DB) and the absolute path.
 */
export function storeInLibrary(src, destName) {
  const dir = libraryDir();
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, destName);
  if (Buffer.isBuffer(src)) {
    fs.writeFileSync(abs, src);
  } else {
    fs.copyFileSync(src, abs);
  }
  const rel = `${path.basename(dir)}/${path.basename(abs)}`.replace(/\\/g, "/");
  return { rel, abs };
}

export function removeFileSafe(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Resolve a DB-stored library-relative path ("2026-09-18/abc.png") to an
 * absolute path that is guaranteed to stay inside ROOT/library. Defense in
 * depth for routes that rebuild fs paths from DB rows: even if a row were
 * ever tampered with, ".." segments or absolute paths cannot escape the
 * library root. Returns null for unsafe inputs.
 */
export function resolveLibraryPath(relPath) {
  if (typeof relPath !== "string" || !relPath) return null;
  // Reject traversal/nulls/absolute roots up front.
  if (relPath.includes("\0") || relPath.split(/[\\/]+/).includes("..")) return null;
  if (path.isAbsolute(relPath)) return null;
  const abs = path.resolve(ROOT, "library", relPath);
  const libRoot = path.resolve(ROOT, "library");
  if (abs !== libRoot && !abs.startsWith(libRoot + path.sep)) return null;
  return abs;
}