import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { notifyAccountChanged } from "./accountEvents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "aliwebdesign.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// ────────────────────────────────────────────────
// Schema — see ALIWEBDESIGN_BUILD_SPEC.md section 5
// ────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,           -- 'niche-variations' | 'art-style-niche' | 'design-to-design' | 'edit'
  parent_id TEXT,                  -- set when feature = 'edit': the design this was edited from
  source_image_path TEXT,          -- base design (niche-variations, design-to-design) or niche-ref (art-style-niche)
  style_image_path TEXT,           -- only used by art-style-niche
  output_image_path TEXT NOT NULL,
  prompt_used TEXT NOT NULL,
  user_input TEXT,                 -- the free-text idea/niche/edit instruction the user typed
  folder TEXT DEFAULT 'Unsorted',  -- for the My Designs library view
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES designs(id)
);

-- Performance indices for filtered & paginated library scans
CREATE INDEX IF NOT EXISTS idx_designs_folder_created
  ON designs (folder, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_designs_feature_created
  ON designs (feature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_designs_created_at
  ON designs (created_at DESC);

-- One row per hidden browser profile (one Google account each, signed in once
-- via Brave/Chrome). The browser session inside profile_dir IS the credential
-- for Gemini — there is no OAuth client and no API key.
CREATE TABLE IF NOT EXISTS browser_accounts (
  id TEXT PRIMARY KEY,
  email TEXT,                      -- from the signed-in Google session, for display
  browser TEXT NOT NULL,           -- 'brave' | 'chrome' | 'google' ('google' = chrome binary)
  profile_dir TEXT NOT NULL,       -- root-relative path to the hidden user-data dir
  status TEXT NOT NULL DEFAULT 'checking',  -- 'ready'|'signed_out'|'error'|'checking' (cached)
  usage_daily TEXT,                -- best-effort quota readouts, null until measured
  usage_weekly TEXT,
  last_error TEXT,                 -- human-readable reason for non-ready / error
  added_at TEXT DEFAULT (datetime('now')),
  last_checked_at TEXT
);

-- One row per successful generation, stamped at generation time.
CREATE TABLE IF NOT EXISTS generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,        -- browser_accounts.id
  ts INTEGER NOT NULL,             -- epoch ms of the successful generation
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_generation_log_account_ts
  ON generation_log (account_id, ts);

DROP TABLE IF EXISTS gemini_accounts;
DROP TABLE IF EXISTS gemini_connection;
`);

// ────────────────────────────────────────────────
// Telemetry columns — added on boot for existing DBs
// ────────────────────────────────────────────────
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumn("browser_accounts", "generation_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("browser_accounts", "last_used_at", "TEXT");
// Fleet control: 1 = participates in generation, 0 = disabled (never picked).
ensureColumn("browser_accounts", "active", "INTEGER NOT NULL DEFAULT 1");

// ────────────────────────────────────────────────
// Startup lock clear — hung statuses never persist.
//
// Refined boot sweep: Sweep hung statuses back to 'ready', but strictly
// respect intentional states:
// 1. Never revive accounts manually disabled (active = 0 or status = 'disabled').
// 2. Never mask persistent session errors (status = 'error').
// ────────────────────────────────────────────────
db.exec(`
  UPDATE browser_accounts
     SET status = 'ready'
   WHERE active = 1
     AND status IN ('generating', 'running', 'checking')
`);

// ────────────────────────────────────────────────
// One-time backfill of the generation log.
// ────────────────────────────────────────────────
{
  const logCount = db.prepare(`SELECT COUNT(*) AS n FROM generation_log`).get().n;
  if (logCount === 0) {
    const legacy = db
      .prepare(
        `SELECT id, generation_count, last_used_at FROM browser_accounts
          WHERE generation_count > 0 AND last_used_at IS NOT NULL`
      )
      .all();
    const insert = db.prepare(
      `INSERT INTO generation_log (account_id, ts, created_at) VALUES (?, ?, ?)`
    );
    const backfill = db.transaction(() => {
      for (const row of legacy) {
        const ts = Date.parse(`${row.last_used_at.replace(" ", "T")}Z`);
        if (!Number.isFinite(ts)) continue;
        for (let i = 0; i < row.generation_count; i++) {
          insert.run(row.id, ts, row.last_used_at);
        }
      }
    });
    backfill();
  }
}

// ────────────────────────────────────────────────
// Browser accounts (profiles)
// ────────────────────────────────────────────────
const accountStmts = {
  get: db.prepare(`SELECT * FROM browser_accounts WHERE id = ?`),
  list: db.prepare(`SELECT * FROM browser_accounts ORDER BY added_at DESC, rowid DESC`),
  listReady: db.prepare(
    `SELECT * FROM browser_accounts WHERE active = 1 AND status = 'ready' ORDER BY last_used_at ASC NULLS FIRST, added_at ASC, rowid ASC`
  ),
  // Atomic claim: selects the least recently used ready account and marks it 'running' in a single step
  claimNextReady: db.prepare(`
    UPDATE browser_accounts
       SET status = 'running'
     WHERE id = (
       SELECT id FROM browser_accounts
        WHERE active = 1 AND status = 'ready'
        ORDER BY last_used_at ASC NULLS FIRST, added_at ASC
        LIMIT 1
     )
    RETURNING *
  `),
  insert: db.prepare(
    `INSERT INTO browser_accounts (id, email, browser, profile_dir, status, usage_daily, usage_weekly, last_error)
     VALUES (@id, @email, @browser, @profile_dir, @status, @usage_daily, @usage_weekly, @last_error)`
  ),
  setStatus: db.prepare(
    `UPDATE browser_accounts
        SET status = @status, email = COALESCE(@email, email),
            usage_daily = COALESCE(@usage_daily, usage_daily),
            usage_weekly = COALESCE(@usage_weekly, usage_weekly),
            last_error = CASE WHEN @clear_error = 1 THEN NULL ELSE COALESCE(@last_error, last_error) END,
            last_checked_at = datetime('now')
      WHERE id = @id`
  ),
  setAllChecking: db.prepare(`UPDATE browser_accounts SET status = 'checking', last_checked_at = datetime('now')`),
  touchLastUsed: db.prepare("UPDATE browser_accounts SET last_used_at = datetime('now') WHERE id = ?"),
  recordGeneration: db.prepare(
    `UPDATE browser_accounts
        SET generation_count = generation_count + 1,
            last_used_at = datetime('now')
      WHERE id = ?`
  ),
  logGeneration: db.prepare(`INSERT INTO generation_log (account_id, ts) VALUES (?, ?)`),
  pruneGenerationLog: db.prepare(`DELETE FROM generation_log WHERE ts < ?`),
  remove: db.prepare(`DELETE FROM browser_accounts WHERE id = ?`),
};

export function getAccountById(id) {
  return accountStmts.get.get(id) ?? null;
}

export function listAccounts() {
  return accountStmts.list.all();
}

/** All active + ready accounts, oldest first (stable fleet order). */
export function listReadyAccounts() {
  return accountStmts.listReady.all();
}

/**
 * Atomically claim the least recently used active+ready account and mark it 'running'.
 * Returns the account object if claimed, or null if all accounts are busy.
 */
export function claimNextReadyAccount(excludeIds = []) {
  if (!Array.isArray(excludeIds) || excludeIds.length === 0) {
    return accountStmts.claimNextReady.get() ?? null;
  }
  const placeholders = excludeIds.map(() => "?").join(",");
  const stmt = db.prepare(`
    UPDATE browser_accounts
       SET status = 'running'
     WHERE id = (
       SELECT id FROM browser_accounts
        WHERE active = 1 AND status = 'ready' AND id NOT IN (${placeholders})
        ORDER BY last_used_at ASC NULLS FIRST, added_at ASC
        LIMIT 1
     )
    RETURNING *
  `);
  return stmt.get(...excludeIds) ?? null;
}

/**
 * Set an account's status directly (used by parallel workers to claim or release an account).
 */
export function setAccountStatus(id, status, clearError = null) {
  const shouldClear = clearError !== null ? (clearError ? 1 : 0) : (status === "ready" ? 1 : 0);
  if (shouldClear === 1) {
    db.prepare(`UPDATE browser_accounts SET status = ?, last_error = NULL WHERE id = ?`).run(status, id);
  } else {
    db.prepare(`UPDATE browser_accounts SET status = ? WHERE id = ?`).run(status, id);
  }
  notifyAccountChanged(id, `status:${status}`);
}

export function insertAccount({ id, email = null, browser, profile_dir, status = "checking" }) {
  accountStmts.insert.run({
    id,
    email,
    browser,
    profile_dir,
    status,
    usage_daily: null,
    usage_weekly: null,
    last_error: null,
  });
  notifyAccountChanged(id, "insert");
  return getAccountById(id);
}

/** Persist a fresh status/email/usage readout for an account. */
export function updateAccountStatus(id, { status, email, usage_daily, usage_weekly, last_error, clear_error }) {
  accountStmts.setStatus.run({
    id,
    status,
    email: email ?? null,
    usage_daily: usage_daily ?? null,
    usage_weekly: usage_weekly ?? null,
    last_error: last_error ?? null,
    clear_error: clear_error !== undefined ? (clear_error ? 1 : 0) : (status === "ready" ? 1 : 0),
  });
  notifyAccountChanged(id, `update:${status}`);
  return getAccountById(id);
}

/**
 * Count one successful generation for an account and stamp its last-used time.
 */
export function recordGeneration(id) {
  const run = db.transaction(() => {
    accountStmts.recordGeneration.run(id);
    accountStmts.logGeneration.run(id, Date.now());
    accountStmts.pruneGenerationLog.run(Date.now() - 40 * 24 * 60 * 60 * 1000);
  });
  run();
  notifyAccountChanged(id, "generation");
  return getAccountById(id);
}

export function generationCountsSince(sinceTs) {
  const rows = db
    .prepare(`SELECT account_id, COUNT(*) AS n FROM generation_log WHERE ts >= ? GROUP BY account_id`)
    .all(sinceTs);
  return Object.fromEntries(rows.map((r) => [r.account_id, r.n]));
}

export function countAllGenerationsSince(sinceTs) {
  return db.prepare(`SELECT COUNT(*) AS n FROM generation_log WHERE ts >= ?`).get(sinceTs).n;
}

export function totalGenerationsFor(accountId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM generation_log WHERE account_id = ?`).get(accountId).n;
}

export function markAllAccountsChecking() {
  accountStmts.setAllChecking.run();
}

/**
 * Startup reconciliation — reset any orphaned 'generating'/'running'/'busy'
 * account states back to 'ready'. Called explicitly at server boot (in
 * addition to the boot sweep above) so a crash mid-generation can never leave
 * the fleet permanently locked. Respects intentional states: never revives
 * disabled accounts or masks persistent session errors.
 * @returns {number} how many accounts were reset
 */
export function reconcileAccountStates() {
  const info = db
    .prepare(
      `UPDATE browser_accounts
          SET status = 'ready'
        WHERE active = 1
          AND status IN ('generating', 'running', 'busy')`
    )
    .run();
  return info.changes;
}

// ────────────────────────────────────────────────
// Runtime watchdog — rescue accounts stuck mid-session.
//
// FIX: The boot sweep only runs at startup; a hung browser during runtime
// would permanently strand accounts. This interval checks every 5 minutes
// and resets any account stuck in 'running' or 'generating' for > 5 min.
// ────────────────────────────────────────────────
const _stuckAccountWatchdog = db.prepare(
  `UPDATE browser_accounts
      SET status = 'ready'
    WHERE active = 1
      AND status IN ('running', 'generating')
      AND last_used_at < datetime('now', '-5 minutes')`
);
setInterval(() => {
  try {
    const info = _stuckAccountWatchdog.run();
    if (info.changes > 0) {
      console.log(`[db] Watchdog: reset ${info.changes} stuck account(s) back to ready.`);
      notifyAccountChanged(null, "watchdog_reset");
    }
  } catch (err) {
    console.error("[db] Watchdog error:", err.message);
  }
}, 5 * 60 * 1000);

export function deleteAccountRow(id) {
  const result = accountStmts.remove.run(id);
  notifyAccountChanged(id, "delete");
  return result;
}

// ────────────────────────────────────────────────
// Designs
// ────────────────────────────────────────────────
const designStmts = {
  insert: db.prepare(
    `INSERT INTO designs
       (id, feature, parent_id, source_image_path, style_image_path,
        output_image_path, prompt_used, user_input, folder)
     VALUES
       (@id, @feature, @parent_id, @source_image_path, @style_image_path,
        @output_image_path, @prompt_used, @user_input, @folder)`
  ),
  get: db.prepare(`SELECT * FROM designs WHERE id = ?`),
  list: db.prepare(
    `SELECT * FROM designs
     WHERE (@folder IS NULL OR folder = @folder)
       AND (@feature IS NULL OR feature = @feature)
     ORDER BY created_at DESC, rowid DESC
     LIMIT @limit OFFSET @offset`
  ),
  count: db.prepare(
    `SELECT COUNT(*) AS n FROM designs
     WHERE (@folder IS NULL OR folder = @folder)
       AND (@feature IS NULL OR feature = @feature)`
  ),
  folders: db.prepare(`SELECT DISTINCT folder FROM designs ORDER BY folder`),
  setFolder: db.prepare(`UPDATE designs SET folder = ? WHERE id = ?`),
  remove: db.prepare(`DELETE FROM designs WHERE id = ?`),
  refCount: db.prepare(
    `SELECT COUNT(*) AS n FROM designs WHERE source_image_path = ? OR style_image_path = ? OR output_image_path = ?`
  ),
};

export function insertDesign(design) {
  designStmts.insert.run({
    folder: "Unsorted",
    parent_id: null,
    source_image_path: null,
    style_image_path: null,
    user_input: null,
    ...design,
  });
  return getDesignById(design.id);
}

export function getDesignById(id) {
  return designStmts.get.get(id) ?? null;
}

export function getDesigns({ folder = null, feature = null, page = 1, pageSize = 60 } = {}) {
  const offset = (page - 1) * pageSize;
  const rows = designStmts.list.all({ folder, feature, limit: pageSize, offset });
  const { n } = designStmts.count.get({ folder, feature });
  return { rows, total: n, page, pageSize };
}

export function listFolders() {
  return designStmts.folders.all().map((r) => r.folder);
}

export function setDesignFolder(id, folder) {
  designStmts.setFolder.run(folder, id);
}

export function deleteDesignRow(id) {
  return designStmts.remove.run(id);
}

export function countPathRefs(relPath) {
  return designStmts.refCount.get(relPath, relPath, relPath)?.n ?? 0;
}
/** Touch last_used_at timestamp immediately so LRU rotation ticks */
export function touchAccount(id) {
  if (!id) return;
  try {
    accountStmts.touchLastUsed.run(id);
  } catch (err) {
    console.error("[DB] Failed to touch account timestamp:", err.message);
  }
}
