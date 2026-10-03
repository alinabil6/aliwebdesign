import { Router } from "express";
import {
  addAccount,
  loginAccount,
  checkAccount,
  quickCheckAccount,
  checkAll,
  debugAccount,
  hasReadyAccount,
  listAccountsWithAbs,
  removeAccount,
} from "../lib/accounts.js";
import { getAccountById, updateAccountStatus } from "../lib/db.js";
import { buildUsagePayload } from "../lib/usage.js";

const router = Router();

// Account row → API shape (no filesystem paths, no internal fields).
function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    browser: row.browser,
    status: row.status,
    generation_count: row.generation_count,
    last_used_at: row.last_used_at,
    usage_daily: row.usage_daily,
    usage_weekly: row.usage_weekly,
    last_error: row.last_error,
    added_at: row.added_at,
    last_checked_at: row.last_checked_at,
  };
}

// GET /api/accounts — all profiles with cached status, plus each account's
// self-tracked usage meters and the fleet/best recommendation payload.
router.get("/", (req, res) => {
  const rows = listAccountsWithAbs();
  const tz = req.query.tz || null;
  const usagePayload = buildUsagePayload(rows, Date.now(), tz);
  res.json({
    accounts: rows.map(toApi).map((a) => ({ ...a, usage: usagePayload.usage[a.id] ?? null })),
    fleet: usagePayload.fleet,
    best: usagePayload.best,
    caps: usagePayload.caps,
  });
});

// GET /api/accounts/usage — the full tracking payload in one call: per-account
// daily/weekly percentages + reset moments + last-used, fleet totals, and the
// "best to use next" recommendation. The accounts view polls this.
router.get("/usage", (req, res) => {
  const rows = listAccountsWithAbs();
  const tz = req.query.tz || null;
  res.json({ accounts: rows.map(toApi), ...buildUsagePayload(rows, Date.now(), tz) });
});

// GET /api/accounts/summary — lightweight "any account ready to generate?"
// shape for the nav/badge and the generation 503 gate.
router.get("/summary", (req, res) => {
  const accounts = listAccountsWithAbs();
  const payload = buildUsagePayload(accounts);
  res.json({
    anyReady: accounts.some((a) => a.status === "ready"),
    readyCount: accounts.filter((a) => a.status === "ready").length,
    total: accounts.length,
    generationsToday: payload.fleet.generationsToday,
    generationsWeek: payload.fleet.generationsWeek,
    best: payload.best,
  });
});

// POST /api/accounts — add an account. Opens a sign-in browser window and
// BLOCKS until the login is auto-detected (up to ~2 min). On success the
// window has already closed itself and the row is persisted 'ready'.
// body: { browser: 'chrome' | 'brave' | 'google' }
router.post("/", async (req, res) => {
  const browser = String(req.body?.browser || "").trim();
  if (browser !== "chrome" && browser !== "brave" && browser !== "google") {
    return res.status(400).json({ error: "browser must be 'chrome', 'brave' or 'google'" });
  }
  try {
    const result = await addAccount(browser);
    res.json({ success: true, email: result.email, status: result.status, account: toApi(result.account) });
  } catch (err) {
    console.error("add account failed:", err);
    res.status(500).json({ success: false, error: "Could not add account" });
  }
});

// PATCH /api/accounts/:id — rename/alias the account's display label. The
// email column doubles as the label; the real address is re-detected on the
// next successful check.
router.patch("/:id", async (req, res) => {
  const row = getAccountById(req.params.id);
  if (!row) return res.status(404).json({ error: "Account not found" });
  const label = String(req.body?.label ?? "").trim().slice(0, 120);
  if (!label) return res.status(400).json({ error: "label is required" });
  // updateAccountStatus sets `status` unconditionally (no COALESCE), so pass the
  // current status through — omitting it binds NULL and trips the NOT NULL constraint.
  const updated = updateAccountStatus(row.id, { status: row.status, email: label });
  res.json({ account: toApi(updated) });
});

// POST /api/accounts/check-all — live-check every profile.
router.post("/check-all", async (req, res) => {
  try {
    // Fire sequentially but return partial results even if one probe fails,
    // so the dashboard still shows whatever was measured.
    await checkAll();
    res.json({ accounts: listAccountsWithAbs().map(toApi) });
  } catch (err) {
    console.error("check-all failed:", err);
    res.status(500).json({ error: "Could not check accounts" });
  }
});

// GET /api/accounts/:id/status — non-disruptive check the frontend polls
// during the add-account flow. Never navigates the user's sign-in window.
router.get("/:id/status", async (req, res) => {
  const status = await quickCheckAccount(req.params.id);
  if (!status) return res.status(404).json({ error: "Account not found" });
  // Same persisted-email echo as POST /:id/check, so either probe path
  // reflects the address stored in browser_accounts.
  const row = getAccountById(req.params.id);
  res.json({ ...status, email: row?.email ?? status.email ?? null });
});

// POST /api/accounts/:id/check — authoritative re-check ("Check" button and
// the "Done signing in" button). Probes on a throwaway tab; when signed in it
// persists 'ready' and closes the launch window to release Windows file locks.
// POST /api/accounts/:id/login — open visible window for manual login / re-authentication
router.post("/:id/login", async (req, res) => {
  const row = getAccountById(req.params.id);
  if (!row) return res.status(404).json({ error: "Account not found" });
  try {
    const result = await loginAccount(req.params.id);
    res.json({ success: true, email: result.email, status: result.status, account: toApi(result.account) });
  } catch (err) {
    console.error("loginAccount failed:", err);
    res.status(500).json({ error: String(err?.message || "Login failed") });
  }
});

router.post("/:id/check", async (req, res) => {
  const status = await checkAccount(req.params.id);
  if (!status) return res.status(404).json({ error: "Account not found" });
  // Echo the persisted row's email so the UI shows what the DB now holds —
  // even when the probe fell back to the previously stored address.
  const row = getAccountById(req.params.id);
  res.json({ ...status, email: row?.email ?? status.email ?? null });
});

// POST /api/accounts/:id/debug — dump live page state (selector calibration).
// Dev-only convenience; harmless on a localhost app.
router.post("/:id/debug", async (req, res) => {
  try {
    const report = await debugAccount(req.params.id);
    if (!report) return res.status(404).json({ error: "Account not found" });
    res.json(report);
  } catch (err) {
    console.error("debug account failed:", err);
    res.status(500).json({ error: "Debug failed" });
  }
});

// DELETE /api/accounts/:id — remove an account (browser, profile dir, row).
router.delete("/:id", async (req, res) => {
  const row = getAccountById(req.params.id);
  if (!row) return res.status(404).json({ error: "Account not found" });
  await removeAccount(req.params.id);
  res.json({ ok: true });
});

export default router;