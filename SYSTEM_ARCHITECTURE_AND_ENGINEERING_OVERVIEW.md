# ALIWEBDESIGN (Magic Fabrica Studio) — Technical Architecture & Engine Specification

## 1. Executive Summary & Value Proposition
ALIWEBDESIGN (UI: Magic Fabrica) is an autonomous print-on-demand production engine that automates vector graphic redraws, cross-niche derivative scaling, prompt-to-image synthesis, and automated e-commerce catalog listing generation across a pooled fleet of Google Gemini web sessions.

The system drives authenticated headless Chromium profiles via Playwright, governed by an autonomous queuing engine, crash-neutralization mechanics, and direct-memory canvas scrapers.

---

## 2. Global Architecture & Component Interaction

```
+------------------------------------------------------------------------+
|                   FRONTEND (HTML5 / Vanilla JS / CSS)                  |
|   * Niche Variations   * Design to Design   * Text to Image            |
|   * Pixel to Pixel     * Art Style + Niche  * Magic Listing / Styles   |
+-----------------------------------+------------------------------------+
| HTTP / Multipart / NDJSON Stream
v
+------------------------------------------------------------------------+
|                     BACKEND ROUTE LAYER (Express 5)                    |
|   * /api/generate/*    * /api/accounts/*    * /api/designs/*           |
|   * Multer Disk/Memory * AbortController    * Error Boundary Traps     |
+-----------------------------------+------------------------------------+
| Tasks (Prompt + Ref Paths)
v
+------------------------------------------------------------------------+
|               ORCHESTRATION & QUEUE ENGINE (queue.js)                  |
|   * Global Fleet Launch Gate (2500ms staggered browser boot)           |
|   * Dynamic Account Leaser & Usage Ranker (usage.js / db.js)           |
|   * Auto-Failover & Quarantine State Machine                           |
+-----------------------------------+------------------------------------+
| Account Context Lease
v
+------------------------------------------------------------------------+
|             BROWSER & PROFILE CONTROLLER (browser.js)                  |
|   * Persistent User-Data Profiles (profiles/acc_*)                     |
|   * Anti-Detection Scripting (navigator.webdriver = undefined)         |
|   * Fast Process Elimination (Win32 process termination)               |
+-----------------------------------+------------------------------------+
| Active Page Handle
v
+------------------------------------------------------------------------+
|             DOM AUTOMATION & EXTRACTION (geminiweb.js)                 |
|   * File Attachment via Playwright FileChooser                         |
|   * Multi-Lingual Consent Sweeper (EN, FR, AR)                         |
|   * In-Session Nudge Auto-Retry (Turns conversational text to image)   |
|   * Direct Canvas In-Memory Output Scraper (Raw PNG bytes >= 512px)    |
|   * 3-Second Refusal Detection (Send button re-enable watcher)         |
+-----------------------------------+------------------------------------+
| Rendered PNG Buffer
v
+------------------------------------------------------------------------+
|                   PERSISTENCE LAYER (SQLite + FS)                      |
|   * aliwebdesign.db (WAL Mode)              * /library/YYYY-MM-DD/     |
|   * designs Table                           * browser_accounts Table   |
|   * generation_log Telemetry                * Atomic Claim Locks       |
+------------------------------------------------------------------------+
```

---

## 3. Directory Layout & Key Modules

* `backend/index.js`: Express entry point, static asset host, and global route mounting.
* `backend/lib/browser.js`: Persistent Playwright browser launcher, command-line arguments (`--headless=new`, window positions), and orphan process management.
* `backend/lib/queue.js`: Global fleet concurrency manager. Enforces a 2500ms launch delay between all browser launches, dynamic account leasing, and auto-failover task re-routing.
* `backend/lib/geminiweb.js`: Web driver for `gemini.google.com/app`. Automates attachment dialogs, dismisses international modals, monitors generation streams, executes in-session nudges, and extracts raw output images via Canvas API.
* `backend/lib/gemini.js`: Bridge connecting tasks from `queue.js` to `geminiweb.js`. Dispatches single runs and neutralizes pages to `about:blank` on errors.
* `backend/lib/accountPool.js`: Specialized slot leaser for synchronous background analysis operations (e.g., Magic Style classification).
* `backend/lib/accounts.js`: Google account registry, profile creation, and live authentication health probing.
* `backend/lib/backgroundEnforcer.js`: Polymorphic background directive builder. Provides unified support for String interpolation and structured Object property access (`.prefix`, `.body`, `.suffix`).
* `backend/lib/styleResolver.js` & `stylesRegistry.js`: 61-style artistic taxonomy engine and directive injector.
* `backend/lib/db.js`: SQLite database layer managed via `better-sqlite3` in Write-Ahead Logging (WAL) mode.
* `backend/prompts/*`: Specialized prompt builders for each generation mode.

---

## 4. Generator Workflow Specifications

### I. Niche Variations (`/api/generate/niche-variations`)
* **Input:** 1 master design concept + multiple niche targets (e.g., `cat, truck, ear`).
* **Behavior:** Automatically segments target lists, maps slots to tasks, and dispatches them across the ready fleet.
* **Preservation Directives:** Locks composition, typography hierarchy, and framing while swapping only the core focal variable.

### II. Design to Design (`/api/generate/design-to-design`)
* **Input:** Up to 100 rasterized source designs.
* **Behavior:** Reconstructs concepts into clean, print-ready 2D vector apparel graphics. Strips compression artifacts, blurs, and product mockups.

### III. Text to Image (`/api/generate/text-to-image`)
* **Input:** Plain-text concept prompt + variation multiplier (1–100) + optional style ID.
* **Behavior:** Injects apparel negative-prompts and cycles through rotating style anchors.

### IV. Pixel to Pixel (`/api/generate/pixel-to-pixel`)
* **Input:** Low-resolution artwork.
* **Behavior:** Performs high-contrast vector redraw while strictly preserving source composition and proportions.

### V. Art Style + Niche (`/api/generate/art-style-niche`)
* **Input:** 1 niche subject reference + up to 10 artistic style references.
* **Behavior:** Fuses aesthetic characteristics via text directives while maintaining a single image upload to prevent Imagen 3 multi-attachment refusals.

### VI. Magic Listing (`/api/magic-listing/*`)
* **Input:** Rendered graphic image + optional research keywords.
* **Behavior:** Produces sanitized, strict-character-limit JSON metadata for Amazon Merch on Demand and TeePublic, enforcing strict trademark negative filters.

---

## 5. Resolved Failure Modes & System Post-Mortems

### 1. The Global Launch Thundering Herd
* **Symptom:** Submitting batches across multiple designs caused simultaneous Chromium boots at T=0, pegging CPU at 100% and timing out locators.
* **Root Cause:** Launch staggers were scoped to intra-batch loops; multiple concurrent HTTP requests triggered parallel workers simultaneously.
* **Resolution:** Implemented a global fleet launch gate in `queue.js` (`acquireGlobalLaunchSlot()`), guaranteeing a minimum 2500ms spacing between any browser process boots system-wide.

### 2. The French/Arabic Google Modal Blocker
* **Symptom:** Accounts operating from Moroccan IP ranges occasionally timed out on the attach button after 20 seconds.
* **Root Cause:** Google displayed localized consent/cookie dialogs (`J'accepte`, `Accepter tout`, `Continuer`) that covered the DOM.
* **Resolution:** Expanded `dismissModals()` in `geminiweb.js` to sweep English, French, and Arabic button variants and dialog containers before probing UI controls.

### 3. The 120-Second Text-Refusal Freeze
* **Symptom:** Gemini text refusals caused workers to hang for up to 120 seconds before failing.
* **Root Cause:** The watcher only checked for new `<img>` elements, waiting until hard timeouts elapsed if no image appeared.
* **Resolution:** Added real-time stream completion detection. When the Send button re-enables and the Stop button disappears, a 2.5s settling check runs; if no image is present, the task fails immediately (under 3 seconds).

### 4. In-Session Soft Refusal Auto-Nudge
* **Symptom:** Gemini occasionally responded with conversational text instead of calling Imagen 3, leading to unnecessary account failovers.
* **Resolution:** Integrated an in-session retry mechanism. If Gemini replies with text without a hard daily quota error, the worker sends an immediate follow-up nudge in the same turn (`"Generate and render the actual 2D vector graphic image now..."`), generating the image on the same account without re-uploading files.

### 5. Account Quarantine Fleet Starvation
* **Symptom:** Fleet capacity dropped to `0 of 6 accounts ready` after minor generation hiccups.
* **Root Cause:** Any failure applied an indiscriminate 15-minute ban, draining the active worker pool.
* **Resolution:** Split failure types into hard daily quotas (15-minute bench) and transient text hiccups (10-second cooldown), preserving pool availability.

### 6. The `[object Object]` Background Type Collision
* **Symptom:** Background styling directives rendered as `[object Object]` in prompts.
* **Root Cause:** `pixelToPixel.js` accessed `.prefix`, `.body`, and `.suffix` properties, whereas other prompts expected a string primitive.
* **Resolution:** Updated `backgroundEnforcer.js` to return a `String` instance enriched with custom object properties, allowing seamless string interpolation and property access.

### 7. Archiver Export Runtime Crash
* **Symptom:** Downloading ZIP exports threw `TypeError: ZipArchive is not a constructor`.
* **Root Cause:** Incorrect named import from `archiver` in an ES module context.
* **Resolution:** Switched to CommonJS resolution via `createRequire(import.meta.url)` in `backend/routes/designs.js`.

---

## 6. Active Database Schema (SQLite WAL Mode)

```sql
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

CREATE TABLE IF NOT EXISTS browser_accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  browser TEXT NOT NULL,
  profile_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'checking',
  usage_daily TEXT,
  usage_weekly TEXT,
  last_error TEXT,
  generation_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  added_at TEXT DEFAULT (datetime('now')),
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS generation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## 7. Operational Guidelines for Future Development

1. **Browser Profiles:**
   * Never delete `profiles/acc_*` while Node.js is running; active Chromium locks will throw `EPERM` on Windows.
   * If browser processes hang, use `Get-Process chrome, brave | Stop-Process -Force` (or `killall chromium` on Linux).

2. **Selector Drift:**
   * Google updates Gemini Web selectors periodically. If attachments fail, verify the Upload & tools accessibility labels in `backend/lib/geminiweb.js`.

3. **Daily Quota Management:**
   * Consumer Gemini accounts allow approximately 30-60 high-resolution image generations per rolling 24-hour window before defaulting to text responses. Maintain at least 5 active profiles in `browser_accounts` for continuous throughput.
