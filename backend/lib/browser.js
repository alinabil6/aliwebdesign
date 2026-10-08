import { chromium } from "playwright";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(LOCAL_APPDATA, "Google", "Chrome", "Application", "chrome.exe"),
];

export const BROWSER_PATHS = {
  chrome: CHROME_PATHS,
  google: CHROME_PATHS,
  brave: [
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    path.join(LOCAL_APPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ],
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
  if (process.platform !== "win32") return;
  // Fast process termination without heavy WMI CIM queries that saturate CPU
  const safe = profileDir.replace(/'/g, "''");
  const script = `Get-Process chrome, brave -ErrorAction SilentlyContinue | Where-Object { \$_.Path } | ForEach-Object { \$id = \$_.Id; \$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = \$id").CommandLine; if (\$cmd -and \$cmd.Contains('${safe}')) { Stop-Process -Id \$id -Force -ErrorAction SilentlyContinue } }`;
  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: "ignore", timeout: 4000 });
  } catch {}
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
  const rawDir = account.profileDirAbs || account.profile_dir || path.join("profiles", account.id || "default");
  const profileDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir);
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
    if (fs.existsSync(srcDbPath + "-wal")) {
      fs.copyFileSync(srcDbPath + "-wal", dst + "-wal");
    }
    if (fs.existsSync(srcDbPath + "-shm")) {
      fs.copyFileSync(srcDbPath + "-shm", dst + "-shm");
    }
    const reader = new Database(dst, { readonly: true, fileMustExist: true });
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

  // 1) Primary Navigation Verification (History SQLite database + WAL)
  const historyPath = path.join(defaultDir, "History");
  let latestUrl = "";
  let latestTitle = "";
  let hasGeminiUrl = false;

  if (fs.existsSync(historyPath)) {
    const historyRows = querySQLiteSafe(historyPath, (db) => {
      try {
        return db.prepare("SELECT url, title, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 10").all();
      } catch (_) {
        return null;
      }
    });

    if (historyRows && historyRows.length > 0) {
      const latest = historyRows[0];
      latestUrl = String(latest?.url || "").toLowerCase();
      latestTitle = String(latest?.title || "").toLowerCase();

      // Check if user is actively on any Google sign-in / verification / captcha / password / 2FA screen
      if (
        latestUrl.includes("accounts.google.com") ||
        latestUrl.includes("/signin") ||
        latestUrl.includes("/challenge") ||
        latestTitle.includes("sign in") ||
        latestTitle.includes("verify it's you") ||
        latestTitle.includes("verify it’s you") ||
        latestTitle.includes("confirm you're not a robot") ||
        latestTitle.includes("confirm you’re not a robot") ||
        latestTitle.includes("2-step") ||
        latestTitle.includes("google accounts")
      ) {
        // Under NO circumstances close the window while the user is still on accounts.google.com
        return false;
      }

      // Check if the latest visited page is actually Gemini
      if (
        (latestUrl.startsWith("https://gemini.google.com") || latestUrl.startsWith("http://gemini.google.com")) &&
        !latestUrl.includes("accounts.google.com")
      ) {
        hasGeminiUrl = true;
      }
    }
  }

  // 2) Cookies Verification (Cookies SQLite database + WAL)
  let hasGeminiCookies = false;
  let hasAuthCookies = false;

  const cookiePaths = [
    path.join(defaultDir, "Network", "Cookies"),
    path.join(defaultDir, "Cookies"),
  ];

  for (const cPath of cookiePaths) {
    if (fs.existsSync(cPath)) {
      const cData = querySQLiteSafe(cPath, (db) => {
        try {
          const geminiCount = db.prepare("SELECT count(*) as c FROM cookies WHERE host_key LIKE '%gemini.google.com%'").get();
          const authCount = db.prepare("SELECT count(*) as c FROM cookies WHERE host_key = '.google.com' AND name IN ('__Secure-1PSID', '__Secure-3PSID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', 'SAPISID')").get();
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

  // If Gemini navigation is confirmed AND auth or Gemini cookies exist -> successfully logged into Gemini!
  if (hasGeminiUrl && (hasGeminiCookies || hasAuthCookies)) {
    return true;
  }

  // If Gemini cookies exist AND Google auth cookies exist AND the latest URL is not on accounts.google.com
  if (hasGeminiCookies && hasAuthCookies && (!latestUrl || !latestUrl.includes("accounts.google.com"))) {
    return true;
  }

  // 3) Session files check fallback (for when SQLite hasn't flushed yet)
  try {
    const sessDir = path.join(defaultDir, "Sessions");
    if (fs.existsSync(sessDir)) {
      const files = fs.readdirSync(sessDir);
      for (const f of files) {
        try {
          const buf = fs.readFileSync(path.join(sessDir, f));
          const str = buf.toString("latin1");
          // If the session file contains active sign-in markers:
          if (str.includes("challenge/recaptcha") || str.includes("signin/challenge") || str.includes("v3/signin")) {
            const geminiIdx = str.lastIndexOf("https://gemini.google.com/app");
            const accountsIdx = Math.max(
              str.lastIndexOf("challenge/recaptcha"),
              str.lastIndexOf("signin/challenge"),
              str.lastIndexOf("v3/signin")
            );
            if (geminiIdx < accountsIdx) {
              // Sign-in challenge is newer than Gemini! Still signing in.
              return false;
            }
          }
          if (str.includes("https://gemini.google.com/app") && (hasGeminiCookies || hasAuthCookies)) {
            return true;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

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
  const rawDir = account.profileDirAbs || account.profile_dir || path.join("profiles", account.id || "default");
  const profileDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir);
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

  const rawDir = account.profileDirAbs || account.profile_dir || path.join("profiles", account.id || "default");
  const profileDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir);

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
