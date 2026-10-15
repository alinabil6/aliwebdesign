import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import accountsRouter from "./routes/accounts.js";
import variationsRouter from "./routes/variations.js";
import designToDesignRouter from "./routes/designToDesign.js";
import artStyleNicheRouter from "./routes/artStyleNiche.js";
import textToImageRouter from "./routes/textToImage.js";
import pixelToPixelRouter from "./routes/pixelToPixel.js";
import prepareDesignsRouter from "./routes/prepareDesigns.js";
import editRouter from "./routes/edit.js";
import designsRouter from "./routes/designs.js";
import stylesRouter from "./routes/styles.js";
import magicListingRouter from "./routes/magicListing.js";
import listingsRouter from "./routes/listings.js";
import cancelRouter from "./routes/cancel.js";
import { closeAll } from "./lib/browser.js";
import { reconcileAccountStates } from "./lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
const PORT = process.env.APP_PORT || process.env.DEFAULT_APP_PORT || (process.env.PORT && process.env.PORT !== "8080" ? process.env.PORT : 3000);

// Startup reconciliation — reset any orphaned 'generating'/'running'/'busy'
// account states left behind by a crash or hard kill, so the fleet never
// boots into a permanently locked state.
const reconciled = reconcileAccountStates();
if (reconciled > 0) {
  console.log(`[boot] Reset ${reconciled} orphaned account state(s) back to ready`);
}

// Gzip/br-compress static + JSON responses.
app.use(compression());

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// Static frontend
app.use(express.static(path.join(ROOT, "frontend")));

// Generated images (stored under /library, served for the UI and downloads)
app.use("/library", express.static(path.join(ROOT, "library")));

// Lucide icon library (npm package served directly — localhost-only app, no bundler)
app.use("/vendor/lucide", express.static(path.join(ROOT, "node_modules", "lucide", "dist")));

// ────────────────────────────────────────────────
// Security middleware — runs before every route.
// ────────────────────────────────────────────────

// Path traversal guard: drop any request whose path decodes to a traversal
// (e.g. /library/..%2f..%2f.env). Express 5 already rejects encoded
// backslashes/dots, but normalize-decode catches what the router may pass to
// fs. Reject with a plain 400 — nothing is served, nothing is leaked.
app.use((req, res, next) => {
  try {
    const decoded = decodeURIComponent(req.path);
    if (decoded.includes("..") || decoded.includes("\0")) {
      return res.status(400).json({ error: "Bad request" });
    }
  } catch {
    return res.status(400).json({ error: "Bad request" });
  }
  next();
});

// Health check — confirms the server is alive
app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "aliwebdesign", time: new Date().toISOString() });
});

// API routes
app.use("/api/accounts", accountsRouter);
app.use("/api/generate", variationsRouter);
app.use("/api/generate", designToDesignRouter);
app.use("/api/generate", artStyleNicheRouter);
app.use("/api/generate", textToImageRouter);
app.use("/api/generate", pixelToPixelRouter);
app.use("/api/generate", cancelRouter);
app.use("/api/prepare-designs", prepareDesignsRouter);
app.use("/api/edit", editRouter);
app.use("/api/designs", designsRouter);
app.use("/api/styles", stylesRouter);
app.use("/api/magic-listing", magicListingRouter);
app.use("/api/listings", listingsRouter);

// Central 404 for unknown API paths (the frontend SPA serves its own static
// route; an unknown /api/* should never fall through to static).
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Generic final error handler — logs the full error server-side, returns a
// safe generic message to the client (never stack traces or file paths).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum file size allowed is 100MB." });
  }
  if (err.name === "MulterError") {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  res.status(err.status || 500).json({ error: "Internal server error" });
});

const HOST = process.env.HOST || "0.0.0.0";
const server = app.listen(PORT, HOST, () => {
  console.log(`aliwebdesign running -> http://${HOST}:${PORT}`);
});
server.on("error", (err) => {
  console.error("Server listen error:", err.message);
});

// Allow long-running 30-50 batch generations without socket drops (10 minutes)
server.setTimeout(600000);

// Shut down profile browsers cleanly so no chromium process is left behind.
async function shutdown() {
  console.log("[server] Shutting down gracefully, closing all browser contexts...");
  try {
    await closeAll();
  } catch (err) {
    console.error("[server] Error closing browser contexts during shutdown:", err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);