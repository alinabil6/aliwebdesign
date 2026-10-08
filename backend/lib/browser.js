import { chromium } from "playwright";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import fs from "fs";
import os from "os";
import path from "path";

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

function safeFileContains(filePath, needles) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const buf = fs.readFileSync(filePath);
    return needles.some((n) => buf.includes(n));
  } catch (_) {
    try {
      const tmpPath = filePath + `.${Date.now()}.tmp`;
      fs.copyFileSync(filePath, tmpPath);
      const buf = fs.readFileSync(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return needles.some((n) => buf.includes(n));
    } catch (_) {
      return false;
    }
  }
}

export function isGeminiAuthenticatedOnDisk(profileDir) {
  const geminiNeedles = [
    Buffer.from("gemini.google.com"),
    Buffer.from("__Secure-1PSID"),
    Buffer.from("__Secure-3PSID"),
  ];

  // 1) Check Default/Sessions
  try {
    const sessDir = path.join(profileDir, "Default", "Sessions");
    if (fs.existsSync(sessDir)) {
      const entries = fs.readdirSync(sessDir);
      for (const e of entries) {
        if (safeFileContains(path.join(sessDir, e), [Buffer.from("gemini.google.com")])) {
          return true;
        }
      }
    }
  } catch (_) {}

  // 2) Check Default/History
  try {
    const defDir = path.join(profileDir, "Default");
    for (const h of ["History", "History-wal", "History-journal"]) {
      if (safeFileContains(path.join(defDir, h), [Buffer.from("gemini.google.com")])) {
        return true;
      }
    }
  } catch (_) {}

  // 3) Check Default/Network/Cookies
  try {
    const netDir = path.join(profileDir, "Default", "Network");
    for (const c of ["Cookies", "Cookies-wal", "Cookies-journal"]) {
      if (safeFileContains(path.join(netDir, c), geminiNeedles)) {
        return true;
      }
    }
    const defCookies = path.join(profileDir, "Default", "Cookies");
    if (safeFileContains(defCookies, geminiNeedles)) {
      return true;
    }
  } catch (_) {}

  // 4) Check Default/Preferences
  try {
    const prefPath = path.join(profileDir, "Default", "Preferences");
    if (fs.existsSync(prefPath)) {
      const content = fs.readFileSync(prefPath, "utf8");
      if (content.includes("account_info") && (content.includes("@gmail.com") || content.includes("@google.com"))) {
        return true;
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

        // Give the browser 1.5s to finish writing cookies and auth tokens to disk
        await new Promise((r) => setTimeout(r, 1500));
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
