import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The root of the project source tree (F:\busine$$\aliwebdesign)
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// This flag is ONLY set to "1" inside the packaged desktop app executable on an end-user machine.
// In local development (node backend/index.js, npm start), it is NOT set, preserving 100% local behavior.
export const IS_PACKAGED = process.env.MF_PACKAGED === "1";

// Persistent user data directory:
// - Packaged: %APPDATA%\magic-fabrica (Windows) or ~/Library/Application Support/magic-fabrica (macOS)
// - Local/Dev: PROJECT_ROOT (F:\busine$$\aliwebdesign)
export const APP_DATA_DIR = IS_PACKAGED
  ? (process.env.USER_DATA_PATH || process.env.MF_DATA_DIR || (
      process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "magic-fabrica")
        : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "magic-fabrica")
        : path.join(os.homedir(), ".config", "magic-fabrica")
    ))
  : PROJECT_ROOT;

// SQLite Database path
// - Packaged: %APPDATA%\magic-fabrica\aliwebdesign.db
// - Local/Dev: backend/aliwebdesign.db (exact current file)
export const DB_PATH = IS_PACKAGED
  ? path.join(APP_DATA_DIR, "aliwebdesign.db")
  : path.join(__dirname, "..", "aliwebdesign.db");

// Persistent directories
export const PROFILES_DIR = path.join(APP_DATA_DIR, "profiles");
export const LIBRARY_DIR = path.join(APP_DATA_DIR, "library");
export const TMP_DIR = path.join(APP_DATA_DIR, "tmp");
