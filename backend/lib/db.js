import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'aliwebdesign.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  parent_id TEXT,
  source_image_path TEXT,
  style_image_path TEXT,
  output_image_path TEXT NOT NULL,
  prompt_used TEXT NOT NULL,
  user_input TEXT,
  folder TEXT DEFAULT 'Unsorted',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES designs(id)
);
CREATE INDEX IF NOT EXISTS idx_designs_folder_created ON designs (folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_designs_feature_created ON designs (feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_designs_created_at ON designs (created_at DESC);

CREATE TABLE IF NOT EXISTS browser_accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  browser TEXT NOT NULL,
  profile_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'checking',
  usage_daily TEXT,
  usage_weekly TEXT,
  last_error TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_generation_log_account_ts ON generation_log (account_id, ts);

CREATE TABLE IF NOT EXISTS listing_review_sessions (
  session_id TEXT PRIMARY KEY,
  design_index INTEGER,
  file_name TEXT,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence_score REAL NOT NULL DEFAULT 0,
  requires_manual_review INTEGER NOT NULL DEFAULT 1,
  raw_model_output TEXT,
  normalized_payload TEXT NOT NULL,
  platform_payload TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_review_platform_created ON listing_review_sessions (platform, created_at DESC);

CREATE TABLE IF NOT EXISTS listing_field_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  ai_value TEXT,
  accepted_value TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',
  reviewed_by TEXT,
  reviewed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, field_name),
  FOREIGN KEY (session_id) REFERENCES listing_review_sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_listing_field_reviews_session ON listing_field_reviews (session_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS taxonomy_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  action TEXT NOT NULL,
  actor_id TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_audit_log_subject ON taxonomy_audit_log (subject_type, subject_key, created_at DESC);

DROP TABLE IF EXISTS gemini_accounts;
DROP TABLE IF EXISTS gemini_connection;
`);

function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumn('browser_accounts', 'generation_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('browser_accounts', 'last_used_at', 'TEXT');
ensureColumn('browser_accounts', 'active', 'INTEGER NOT NULL DEFAULT 1');

db.exec(`
  UPDATE browser_accounts
     SET status = 'ready'
   WHERE active = 1
     AND status IN ('generating', 'running', 'checking')
`);

{
  const logCount = db.prepare(`SELECT COUNT(*) AS n FROM generation_log`).get().n;
  if (logCount === 0) {
    const legacy = db.prepare(`
      SELECT id, generation_count, last_used_at FROM browser_accounts
      WHERE generation_count > 0 AND last_used_at IS NOT NULL
    `).all();
    const insert = db.prepare(`INSERT INTO generation_log (account_id, ts, created_at) VALUES (?, ?, ?)`);
    const backfill = db.transaction(() => {
      for (const row of legacy) {
        const ts = Date.parse(`${row.last_used_at.replace(' ', 'T')}Z`);
        if (!Number.isFinite(ts)) continue;
        for (let i = 0; i < row.generation_count; i++) insert.run(row.id, ts, row.last_used_at);
      }
    });
    backfill();
  }
}

const accountStmts = {
  get: db.prepare(`SELECT * FROM browser_accounts WHERE id = ?`),
  list: db.prepare(`SELECT * FROM browser_accounts ORDER BY added_at DESC, rowid DESC`),
  listReady: db.prepare(`SELECT * FROM browser_accounts WHERE active = 1 AND status = 'ready' ORDER BY last_used_at ASC NULLS FIRST, added_at ASC, rowid ASC`),
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
  insert: db.prepare(`
    INSERT INTO browser_accounts (id, email, browser, profile_dir, status, usage_daily, usage_weekly, last_error)
    VALUES (@id, @email, @browser, @profile_dir, @status, @usage_daily, @usage_weekly, @last_error)
  `),
  setStatus: db.prepare(`
    UPDATE browser_accounts
       SET status = @status,
           email = COALESCE(@email, email),
           usage_daily = COALESCE(@usage_daily, usage_daily),
           usage_weekly = COALESCE(@usage_weekly, usage_weekly),
           last_error = CASE WHEN @clear_error = 1 THEN NULL ELSE COALESCE(@last_error, last_error) END,
           last_checked_at = datetime('now')
     WHERE id = @id
  `),
  setAllChecking: db.prepare(`UPDATE browser_accounts SET status = 'checking', last_checked_at = datetime('now')`),
  touchLastUsed: db.prepare(`UPDATE browser_accounts SET last_used_at = datetime('now') WHERE id = ?`),
  recordGeneration: db.prepare(`
    UPDATE browser_accounts
       SET generation_count = generation_count + 1,
           last_used_at = datetime('now')
     WHERE id = ?
  `),
  logGeneration: db.prepare(`INSERT INTO generation_log (account_id, ts) VALUES (?, ?)`),
  pruneGenerationLog: db.prepare(`DELETE FROM generation_log WHERE ts < ?`),
  remove: db.prepare(`DELETE FROM browser_accounts WHERE id = ?`),
};

const designStmts = {
  insert: db.prepare(`
    INSERT INTO designs (id, feature, parent_id, source_image_path, style_image_path, output_image_path, prompt_used, user_input, folder)
    VALUES (@id, @feature, @parent_id, @source_image_path, @style_image_path, @output_image_path, @prompt_used, @user_input, @folder)
  `),
  get: db.prepare(`SELECT * FROM designs WHERE id = ?`),
  list: db.prepare(`
    SELECT * FROM designs
     WHERE (@folder IS NULL OR folder = @folder)
       AND (@feature IS NULL OR feature = @feature)
     ORDER BY created_at DESC, rowid DESC
     LIMIT @limit OFFSET @offset
  `),
  count: db.prepare(`
    SELECT COUNT(*) AS n FROM designs
     WHERE (@folder IS NULL OR folder = @folder)
       AND (@feature IS NULL OR feature = @feature)
  `),
  folders: db.prepare(`SELECT DISTINCT folder FROM designs ORDER BY folder`),
  setFolder: db.prepare(`UPDATE designs SET folder = ? WHERE id = ?`),
  remove: db.prepare(`DELETE FROM designs WHERE id = ?`),
  refCount: db.prepare(`SELECT COUNT(*) AS n FROM designs WHERE source_image_path = ? OR style_image_path = ? OR output_image_path = ?`),
};

const listingSessionStmts = {
  insert: db.prepare(`
    INSERT INTO listing_review_sessions (
      session_id, design_index, file_name, platform, source, confidence_score,
      requires_manual_review, raw_model_output, normalized_payload, platform_payload, created_by, updated_at
    ) VALUES (
      @session_id, @design_index, @file_name, @platform, @source, @confidence_score,
      @requires_manual_review, @raw_model_output, @normalized_payload, @platform_payload, @created_by, datetime('now')
    )
    ON CONFLICT(session_id) DO UPDATE SET
      design_index = excluded.design_index,
      file_name = excluded.file_name,
      platform = excluded.platform,
      source = excluded.source,
      confidence_score = excluded.confidence_score,
      requires_manual_review = excluded.requires_manual_review,
      raw_model_output = excluded.raw_model_output,
      normalized_payload = excluded.normalized_payload,
      platform_payload = excluded.platform_payload,
      created_by = COALESCE(excluded.created_by, listing_review_sessions.created_by),
      updated_at = datetime('now')
  `),
  get: db.prepare(`SELECT * FROM listing_review_sessions WHERE session_id = ?`),
};

const listingFieldStmts = {
  upsert: db.prepare(`
    INSERT INTO listing_field_reviews (session_id, field_name, ai_value, accepted_value, status, reviewed_by, reviewed_at)
    VALUES (@session_id, @field_name, @ai_value, @accepted_value, @status, @reviewed_by, datetime('now'))
    ON CONFLICT(session_id, field_name) DO UPDATE SET
      ai_value = excluded.ai_value,
      accepted_value = excluded.accepted_value,
      status = excluded.status,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = datetime('now')
  `),
  listBySession: db.prepare(`SELECT * FROM listing_field_reviews WHERE session_id = ? ORDER BY id ASC`),
};

const taxonomyAuditStmts = {
  insert: db.prepare(`
    INSERT INTO taxonomy_audit_log (subject_type, subject_key, old_value, new_value, action, actor_id, metadata)
    VALUES (@subject_type, @subject_key, @old_value, @new_value, @action, @actor_id, @metadata)
  `),
};

export function getAccountById(id) {
  return accountStmts.get.get(id) ?? null;
}

export function listAccounts() {
  return accountStmts.list.all();
}

export function listReadyAccounts() {
  return accountStmts.listReady.all();
}

export function claimNextReadyAccount(excludeIds = []) {
  if (!Array.isArray(excludeIds) || excludeIds.length === 0) return accountStmts.claimNextReady.get() ?? null;
  const placeholders = excludeIds.map(() => '?').join(',');
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

export function setAccountStatus(id, status, clearError = null) {
  const shouldClear = clearError !== null ? (clearError ? 1 : 0) : (status === 'ready' ? 1 : 0);
  if (shouldClear === 1) {
    db.prepare(`UPDATE browser_accounts SET status = ?, last_error = NULL WHERE id = ?`).run(status, id);
  } else {
    db.prepare(`UPDATE browser_accounts SET status = ? WHERE id = ?`).run(status, id);
  }
}

export function insertAccount({ id, email = null, browser, profile_dir, status = 'checking' }) {
  accountStmts.insert.run({ id, email, browser, profile_dir, status, usage_daily: null, usage_weekly: null, last_error: null });
  return getAccountById(id);
}

export function updateAccountStatus(id, { status, email, usage_daily, usage_weekly, last_error, clear_error }) {
  accountStmts.setStatus.run({
    id,
    status,
    email: email ?? null,
    usage_daily: usage_daily ?? null,
    usage_weekly: usage_weekly ?? null,
    last_error: last_error ?? null,
    clear_error: clear_error !== undefined ? (clear_error ? 1 : 0) : (status === 'ready' ? 1 : 0),
  });
  return getAccountById(id);
}

export function recordGeneration(id) {
  const run = db.transaction(() => {
    accountStmts.recordGeneration.run(id);
    accountStmts.logGeneration.run(id, Date.now());
    accountStmts.pruneGenerationLog.run(Date.now() - 40 * 24 * 60 * 60 * 1000);
  });
  run();
  return getAccountById(id);
}

export function generationCountsSince(sinceTs) {
  const rows = db.prepare(`SELECT account_id, COUNT(*) AS n FROM generation_log WHERE ts >= ? GROUP BY account_id`).all(sinceTs);
  return Object.fromEntries(rows.map((row) => [row.account_id, row.n]));
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

export function reconcileAccountStates() {
  return db.prepare(`
    UPDATE browser_accounts
       SET status = 'ready'
     WHERE active = 1
       AND status IN ('generating', 'running', 'busy')
  `).run().changes;
}

export function deleteAccountRow(id) {
  return accountStmts.remove.run(id);
}

export function insertDesign(design) {
  designStmts.insert.run({ folder: 'Unsorted', parent_id: null, source_image_path: null, style_image_path: null, user_input: null, ...design });
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
  return designStmts.folders.all().map((row) => row.folder);
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

export function touchAccount(id) {
  if (!id) return;
  try {
    accountStmts.touchLastUsed.run(id);
  } catch (err) {
    console.error('[DB] Failed to touch account timestamp:', err.message);
  }
}

export function createListingReviewSession({ sessionId, designIndex = null, fileName = null, platform, source, confidenceScore = 0, requiresManualReview = true, rawModelOutput = null, normalizedPayload = {}, platformPayload = {}, createdBy = null }) {
  listingSessionStmts.insert.run({
    session_id: sessionId,
    design_index: designIndex,
    file_name: fileName,
    platform,
    source,
    confidence_score: confidenceScore,
    requires_manual_review: requiresManualReview ? 1 : 0,
    raw_model_output: rawModelOutput,
    normalized_payload: JSON.stringify(normalizedPayload),
    platform_payload: JSON.stringify(platformPayload),
    created_by: createdBy,
  });
  return listingSessionStmts.get.get(sessionId);
}

export function getListingReviewSession(sessionId) {
  const session = listingSessionStmts.get.get(sessionId);
  if (!session) return null;
  return {
    ...session,
    normalized_payload: JSON.parse(session.normalized_payload || '{}'),
    platform_payload: JSON.parse(session.platform_payload || '{}'),
    field_reviews: listingFieldStmts.listBySession.all(sessionId).map((row) => ({
      ...row,
      ai_value: safelyParseJson(row.ai_value),
      accepted_value: safelyParseJson(row.accepted_value),
      metadata: undefined,
    })),
  };
}

export function upsertListingFieldReview({ sessionId, fieldName, aiValue = null, acceptedValue = null, status = 'suggested', reviewedBy = null }) {
  listingFieldStmts.upsert.run({
    session_id: sessionId,
    field_name: fieldName,
    ai_value: JSON.stringify(aiValue),
    accepted_value: JSON.stringify(acceptedValue),
    status,
    reviewed_by: reviewedBy,
  });
  return listingFieldStmts.listBySession.all(sessionId).find((row) => row.field_name === fieldName) ?? null;
}

export function appendTaxonomyAuditLog({ subjectType, subjectKey, oldValue = null, newValue = null, action, actorId = null, metadata = null }) {
  return taxonomyAuditStmts.insert.run({
    subject_type: subjectType,
    subject_key: subjectKey,
    old_value: oldValue === undefined ? null : JSON.stringify(oldValue),
    new_value: newValue === undefined ? null : JSON.stringify(newValue),
    action,
    actor_id: actorId,
    metadata: metadata == null ? null : JSON.stringify(metadata),
  });
}

function safelyParseJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
