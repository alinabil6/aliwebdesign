import { chromium } from "playwright";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { PROFILES_DIR } from "./paths.js";

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

const WIN_CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(LOCAL_APPDATA, "Google", "Chrome", "Application", "chrome.exe"),
];

const MAC_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
];

const LINUX_CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const WIN_BRAVE_PATHS = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  path.join(LOCAL_APPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
];

const MAC_BRAVE_PATHS = [
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  path.join(os.homedir(), "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
];

const LINUX_BRAVE_PATHS = [
  "/usr/bin/brave-browser",
  "/usr/bin/brave",
];

const WIN_EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(LOCAL_APPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
];

const MAC_EDGE_PATHS = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  path.join(os.homedir(), "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
];

const CHROME_PATHS = process.platform === "win32"
  ? WIN_CHROME_PATHS
  : process.platform === "darwin"
  ? MAC_CHROME_PATHS
  : [...LINUX_CHROME_PATHS, ...WIN_CHROME_PATHS];

const BRAVE_PATHS = process.platform === "win32"
  ? WIN_BRAVE_PATHS
  : process.platform === "darwin"
  ? MAC_BRAVE_PATHS
  : [...LINUX_BRAVE_PATHS, ...WIN_BRAVE_PATHS];

const EDGE_PATHS = process.platform === "win32"
  ? WIN_EDGE_PATHS
  : MAC_EDGE_PATHS;

export const BROWSER_PATHS = {
  chrome: CHROME_PATHS,
  google: CHROME_PATHS,
  brave: BRAVE_PATHS,
  edge: EDGE_PATHS,
  msedge: EDGE_PATHS,
};

export function canLaunchBrowser(name = "chrome") {
  const candidates = BROWSER_PATHS[name];
  if (!candidates) return false;
  return candidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export function browserExecutable(name) {
  const candidates = BROWSER_PATHS[name];
  if (!candidates) {
    throw new Error(`Unknown browser '${name}' — choose 'chrome', 'brave' or 'google'`);
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Could not find ${name === "brave" ? "Brave" : "Google Chrome"} on this machine.`);
}

const sessions = new Map();
const mainPages = new Map();

// Runtime lock/flag for active interactive sign-in sessions
export let isInteractiveAuthActive = false;

function makeLock() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const next = tail.then(fn, fn);
      tail = next.catch(() => {});
      return next;
    },
  };
}

const DEBUG_MODE = process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

const VISIBLE_AUTH_ARGS = [
  "--new-window",
  "--start-maximized",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
];

const VISIBLE_AUTH_IGNORE_DEFAULT_ARGS = [
  "--enable-automation",
  "--no-sandbox",
];

function getLaunchArgs(opts = {}) {
  const isVisible = Boolean(opts?.visible);
  return [
    ...(DEBUG_MODE || isVisible ? [] : ["--headless=new"]),
    ...(isVisible ? ["--window-position=100,100", "--window-size=1280,900"] : ["--window-position=-2400,-2400"]),
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-blink-features=AutomationControlled",
  ];
}

export async function killOrphanProcesses(profileDir) {
  // If an interactive sign-in session is active, EXIT IMMEDIATELY
  if (isInteractiveAuthActive) return;
  if (process.platform === "win32") {
    // Fast process termination without heavy WMI CIM queries that saturate CPU
    const safe = profileDir.replace(/'/g, "''");
    const base = path.basename(profileDir).replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'brave.exe'" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -and (\$_.CommandLine.Contains('${safe}') -or \$_.CommandLine.Contains('${base}')) } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    try {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: "ignore", timeout: 4000 });
    } catch {}
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const safe = profileDir.replace(/"/g, '\\"');
      await execAsync(`pkill -9 -f "${safe}"`, { stdio: "ignore", timeout: 3000 });
    } catch {}
  }
}

export function resolveAccountProfileDir(account) {
  const rawDir = account.profileDirAbs || account.profile_dir || path.join("profiles", account.id || "default");
  return path.isAbsolute(rawDir) ? rawDir : path.resolve(PROFILES_DIR, path.basename(rawDir));
}

export async function purgeFleetBrowsers() {
  // If an interactive sign-in session is active, EXIT IMMEDIATELY
  if (isInteractiveAuthActive) {
    console.log("[browser] Interactive sign-in active, skipping fleet browser purge");
    return;
  }
  for (const [id, entry] of sessions.entries()) {
    try {
      await entry.context.close().catch(() => {});
      if (entry.profileDir) {
        await killOrphanProcesses(entry.profileDir).catch(() => {});
      }
    } catch (_) {}
  }
  sessions.clear();
  mainPages.clear();
}

export async function launchProfile(account, opts = {}) {
  const profileDir = resolveAccountProfileDir(account);
  fs.mkdirSync(profileDir, { recursive: true });

  const isVisible = Boolean(opts?.visible);
  if (isVisible) {
    isInteractiveAuthActive = true;
    const browserName = account.browser || "chrome";
    const launchOpts = {
      headless: false,
      viewport: null,
      ignoreDefaultArgs: VISIBLE_AUTH_IGNORE_DEFAULT_ARGS,
      args: VISIBLE_AUTH_ARGS,
    };

    if (browserName === "chrome" || browserName === "google") {
      try {
        return await chromium.launchPersistentContext(profileDir, {
          channel: "chrome",
          ...launchOpts,
        });
      } catch (err) {
        let executablePath;
        try { executablePath = browserExecutable(browserName); } catch (_) {}
        return await chromium.launchPersistentContext(profileDir, {
          ...(executablePath ? { executablePath } : {}),
          ...launchOpts,
        });
      }
    } else {
      launchOpts.executablePath = browserExecutable(browserName);
      return await chromium.launchPersistentContext(profileDir, launchOpts);
    }
  }

  // Headless generation launch
  if (!isInteractiveAuthActive) {
    await killOrphanProcesses(profileDir);
  }

  let executablePath;
  try {
    executablePath = browserExecutable(account.browser);
  } catch (_) {}

  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: getLaunchArgs(opts),
  };
  if (executablePath) {
    launchOpts.executablePath = executablePath;
  } else {
    launchOpts.channel = "chrome";
  }

  return await chromium.launchPersistentContext(profileDir, launchOpts);
}

function externalAuthArgs(profileDir, url) {
  return [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--new-window",
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    url,
  ];
}

function querySQLiteSafe(srcDbPath, queryFn) {
  if (!fs.existsSync(srcDbPath)) return null;
  const tempSub = fs.mkdtempSync(path.join(os.tmpdir(), "mf-probe-"));
  const dst = path.join(tempSub, path.basename(srcDbPath));
  try {
    fs.copyFileSync(srcDbPath, dst);
    // On Windows, SQLite memory-mapped shared memory file (-shm) is exclusively locked
    // by running Chrome processes. Copying -shm fails with EBUSY / EPERM.
    // Standard SQLite WAL reads do NOT require -shm; SQLite will re-create or inspect WAL directly.
    if (fs.existsSync(srcDbPath + "-wal")) {
      try { fs.copyFileSync(srcDbPath + "-wal", dst + "-wal"); } catch (_) {}
    }
    const reader = new Database(dst, { readonly: true, fileMustExist: true, timeout: 2000 });
    try {
      return queryFn(reader);
    } finally {
      reader.close();
    }
  } catch (_) {
    return null;
  } finally {
    try { fs.rmSync(tempSub, { recursive: true, force: true }); } catch (_) {}
  }
}

export function isGeminiAuthenticatedOnDisk(profileDir) {
  const defaultDir = path.join(profileDir, "Default");
  if (!fs.existsSync(defaultDir)) return false;

  // Track state across signals
  let isActivelySigningIn = false;
  let hasNavigatedToGemini = false;
  let hasGoogleAccount = false;
  let hasGeminiCookies = false;
  let hasAuthCookies = false;

  // 1) Preferences Check: Verify whether Google Account is recognized in profile
  try {
    const prefPath = path.join(defaultDir, "Preferences");
    if (fs.existsSync(prefPath)) {
      const content = fs.readFileSync(prefPath, "utf8");
      try {
        const json = JSON.parse(content);
        if (json.account_info && Array.isArray(json.account_info) && json.account_info.length > 0) {
          hasGoogleAccount = true;
        } else if (json.signin?.email || json.google?.services?.signin?.email) {
          hasGoogleAccount = true;
        }
      } catch (_) {}
      if (!hasGoogleAccount && /[a-zA-Z0-9._%+-]+@gmail\.com/i.test(content)) {
        hasGoogleAccount = true;
      }
    }
  } catch (_) {}

  // 2) Navigation & History SQLite Verification
  const historyPath = path.join(defaultDir, "History");
  if (fs.existsSync(historyPath)) {
    const historyRows = querySQLiteSafe(historyPath, (db) => {
      try {
        return db.prepare("SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 15").all();
      } catch (_) {
        return null;
      }
    });

    if (historyRows && historyRows.length > 0) {
      for (const row of historyRows) {
        const url = String(row?.url || "").toLowerCase();
        if (url.includes("gemini.google.com")) {
          hasNavigatedToGemini = true;
          break;
        }
      }

      const latest = historyRows[0];
      const latestUrl = String(latest?.url || "").toLowerCase();
      const latestTitle = String(latest?.title || "").toLowerCase();

      // Check if user is actively on any Google sign-in / verification / captcha / password screen
      if (
        latestUrl.includes("accounts.google.com") ||
        latestUrl.includes("/signin") ||
        latestUrl.includes("/challenge") ||
        latestUrl.includes("/checkcookie") ||
        latestTitle.includes("sign in") ||
        latestTitle.includes("verify it's you") ||
        latestTitle.includes("verify it’s you") ||
        latestTitle.includes("confirm you're not a robot") ||
        latestTitle.includes("confirm you’re not a robot") ||
        latestTitle.includes("2-step") ||
        latestTitle.includes("google accounts")
      ) {
        // Explicitly block auto-close while still on Google Accounts challenges
        isActivelySigningIn = true;
      }
    }
  }

  // 3) Session files check (catches live active tabs even if SQLite hasn't flushed)
  try {
    const sessDir = path.join(defaultDir, "Sessions");
    if (fs.existsSync(sessDir)) {
      const files = fs.readdirSync(sessDir);
      for (const f of files) {
        try {
          const buf = fs.readFileSync(path.join(sessDir, f));
          const str = buf.toString("latin1");

          if (str.includes("gemini.google.com")) {
            hasNavigatedToGemini = true;
          }

          if (str.includes("challenge/recaptcha") || str.includes("signin/challenge") || str.includes("v3/signin")) {
            const geminiIdx = str.lastIndexOf("gemini.google.com");
            const accountsIdx = Math.max(
              str.lastIndexOf("challenge/recaptcha"),
              str.lastIndexOf("signin/challenge"),
              str.lastIndexOf("v3/signin")
            );
            if (accountsIdx > geminiIdx) {
              isActivelySigningIn = true;
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (isActivelySigningIn) {
    return false;
  }

  // 4) Cookies Verification (Cookies SQLite database)
  const cookiePaths = [
    path.join(defaultDir, "Network", "Cookies"),
    path.join(defaultDir, "Cookies"),
  ];

  for (const cPath of cookiePaths) {
    if (fs.existsSync(cPath)) {
      const cData = querySQLiteSafe(cPath, (db) => {
        try {
          const geminiCount = db.prepare("SELECT count(*) as c FROM cookies WHERE host_key LIKE '%gemini.google.com%'").get();
          const authCount = db.prepare("SELECT count(*) as c FROM cookies WHERE host_key = '.google.com' AND name IN ('__Secure-1PSID', '__Secure-3PSID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', 'SAPISID', 'SID', 'SSID')").get();
          return { gemini: geminiCount?.c || 0, auth: authCount?.c || 0 };
        } catch (_) {
          return null;
        }
      });
      if (cData) {
        if (cData.gemini > 0) hasGeminiCookies = true;
        if (cData.auth > 0) hasAuthCookies = true;
      }
      if (hasGeminiCookies && hasAuthCookies) break;
    }
  }

  // Fast check: If Cookies file binary contains Google session cookie indicators
  if (!hasAuthCookies) {
    for (const cPath of cookiePaths) {
      if (fs.existsSync(cPath)) {
        try {
          const buf = fs.readFileSync(cPath);
          const str = buf.toString("latin1");
          if (str.includes("__Secure-1PSID") || str.includes("SAPISID") || str.includes(".google.com")) {
            hasAuthCookies = true;
          }
          if (str.includes("gemini.google.com")) {
            hasGeminiCookies = true;
          }
        } catch (_) {}
      }
    }
  }

  // VERDICT:
  // User has reached Gemini AND is not actively on a sign-in challenge AND (has an authenticated Google profile OR auth/gemini cookies)
  if (hasNavigatedToGemini && (hasGoogleAccount || hasAuthCookies || hasGeminiCookies)) {
    return true;
  }

  return false;
}

export function extractEmailFromProfile(profileDir) {
  try {
    const prefPath = path.join(profileDir, "Default", "Preferences");
    if (fs.existsSync(prefPath)) {
      const content = fs.readFileSync(prefPath, "utf8");
      try {
        const json = JSON.parse(content);
        if (json.account_info && Array.isArray(json.account_info)) {
          for (const acc of json.account_info) {
            if (acc?.email && acc.email.includes("@")) return acc.email;
          }
        }
        if (json.signin?.email && json.signin.email.includes("@")) return json.signin.email;
        if (json.google?.services?.signin?.email && json.google.services.signin.email.includes("@")) {
          return json.google.services.signin.email;
        }
      } catch (_) {}
      const m = content.match(/[a-zA-Z0-9._%+-]+@gmail\.com/i);
      if (m) return m[0];
    }
  } catch (_) {}

  try {
    const cookiesPath = path.join(profileDir, "Default", "Network", "Cookies");
    if (fs.existsSync(cookiesPath)) {
      const buf = fs.readFileSync(cookiesPath);
      const str = buf.toString("latin1");
      const m = str.match(/[a-zA-Z0-9._%+-]+@gmail\.com/i);
      if (m) return m[0];
    }
  } catch (_) {}

  return null;
}

export async function launchExternalAuthSession(account, url, opts = {}) {
  const profileDir = resolveAccountProfileDir(account);
  fs.mkdirSync(profileDir, { recursive: true });

  await killOrphanProcesses(profileDir);

  const executablePath = browserExecutable(account.browser || "chrome");
  const timeoutMs = opts.timeoutMs ?? 300000;

  isInteractiveAuthActive = true;

  return await new Promise((resolve, reject) => {
    const child = spawn(executablePath, externalAuthArgs(profileDir, url), {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });

    let settled = false;
    let pollTimer = null;

    function cleanup() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      isInteractiveAuthActive = false;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (process.platform === "win32") {
          exec(`taskkill /PID ${child.pid} /T /F`, () => {});
        } else {
          child.kill("SIGTERM");
        }
      } catch (_) {}
      resolve({ closed: false, timedOut: true });
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ closed: true, code, signal });
    });

    // Background monitor: watch for successful Gemini navigation & session write
    pollTimer = setInterval(async () => {
      if (settled) {
        clearInterval(pollTimer);
        return;
      }

      if (isGeminiAuthenticatedOnDisk(profileDir)) {
        clearInterval(pollTimer);
        pollTimer = null;

        // Give the browser 2.5s to finish writing cookies and auth tokens to disk
        await new Promise((r) => setTimeout(r, 2500));
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();

        // Programmatically close the browser window
        try {
          if (process.platform === "win32") {
            exec(`taskkill /PID ${child.pid} /T /F`, () => {});
          } else {
            child.kill("SIGTERM");
          }
        } catch (_) {}

        resolve({ closed: true, autoClosed: true });
      }
    }, 1000);
  });
}

async function ensureEntry(account, opts = {}) {
  const existing = sessions.get(account.id);
  if (existing) return existing;

  const profileDir = resolveAccountProfileDir(account);

  const context = await launchProfile(account, opts);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const entry = {
    context,
    browser: context.browser(),
    lock: makeLock(),
    created: Date.now(),
    profileDir,
  };
  sessions.set(account.id, entry);
  context.on("close", () => {
    if (sessions.get(account.id) === entry) sessions.delete(account.id);
    mainPages.delete(account.id);
  });
  return entry;
}

export async function withProfile(account, fn, opts = {}) {
  const isVisible = Boolean(opts?.visible);
  if (isVisible) {
    isInteractiveAuthActive = true;
  }
  try {
    const entry = await ensureEntry(account, opts);
    return await entry.lock.run(async () => {
      const pages = entry.context.pages();
      while (pages.length > 1) {
        const extra = pages.pop();
        await extra.close().catch(() => {});
      }
      let page = pages[0];
      if (!page || page.isClosed()) {
        page = await entry.context.newPage();
      }
      mainPages.set(account.id, page);
      return await fn(page, entry);
    });
  } finally {
    if (isVisible) {
      isInteractiveAuthActive = false;
    }
  }
}

export async function withProbePage(account, fn, opts = {}) {
  const entry = await ensureEntry(account, opts);
  return entry.lock.run(async () => {
    const page = await entry.context.newPage();
    try {
      return await fn(page, entry);
    } finally {
      await page.close().catch(() => {});
    }
  });
}

export function getProfilePage(account, opts = {}) {
  return withProfile(account, async (page) => page, opts);
}

export function isProfileOpen(accountId) {
  return sessions.has(accountId);
}

export async function closeProfile(accountId) {
  const entry = sessions.get(accountId);
  if (!entry) return;
  sessions.delete(accountId);
  mainPages.delete(accountId);
  try {
    await entry.context.close();
  } catch {}
  if (!isInteractiveAuthActive && entry.profileDir) {
    await killOrphanProcesses(entry.profileDir);
  }
}

export function getAccountIdForPage(page) {
  if (!page) return null;
  for (const [id, p] of mainPages.entries()) {
    if (p === page) return id;
  }
  for (const [id, entry] of sessions.entries()) {
    if (entry.context && typeof entry.context.pages === "function") {
      try {
        if (entry.context.pages().includes(page)) return id;
      } catch (_) {}
    }
  }
  return null;
}

export async function closeProfileForPage(page) {
  const accountId = getAccountIdForPage(page);
  if (accountId) {
    await closeProfile(accountId);
    return accountId;
  } else if (page) {
    try {
      const ctx = typeof page.context === "function" ? page.context() : null;
      if (ctx) await ctx.close();
      else if (typeof page.close === "function") await page.close();
    } catch (_) {}
  }
  return null;
}

export async function closeAll() {
  const entries = [...sessions.entries()];
  sessions.clear();
  mainPages.clear();
  await Promise.allSettled(
    entries.map(async ([, entry]) => {
      try {
        await entry.context.close();
      } catch {}
    })
  );
}
