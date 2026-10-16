import { app, BrowserWindow, shell, dialog } from "electron";
import path from "path";
import net from "net";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import { initAutoUpdater } from "./updater.js";

// Global crash handlers as requested by user
process.on("uncaughtException", (err) => {
  const msg = err?.stack || String(err);
  console.error("[FATAL uncaughtException]", msg);
  try {
    const dir = app?.isReady && app.isReady() ? app.getPath("userData") : (process.env.APPDATA || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "startup-crash.log"), msg);
  } catch (_) {}
  try {
    dialog.showErrorBox("Startup Crash", msg);
  } catch (_) {}
});

process.on("unhandledRejection", (err) => {
  const msg = err?.stack || String(err);
  console.error("[FATAL unhandledRejection]", msg);
  try {
    const dir = app?.isReady && app.isReady() ? app.getPath("userData") : (process.env.APPDATA || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "startup-rejection.log"), msg);
  } catch (_) {}
  try {
    dialog.showErrorBox("Unhandled Rejection", msg);
  } catch (_) {}
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CRITICAL SAFETY SWITCH ─────────────────────────────────────
// Only packaged production desktop installers redirect paths to %APPDATA%.
// In development, MF_PACKAGED remains "0", preserving 100% local folder behavior.
process.env.MF_PACKAGED = app.isPackaged ? "1" : "0";
process.env.HOST = "127.0.0.1";

if (app.isPackaged) {
  const userDataPath = app.getPath("userData");
  process.env.MF_DATA_DIR = userDataPath;
  process.env.USER_DATA_PATH = userDataPath;
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    process.chdir(userDataPath);
  } catch (err) {
    console.error("Failed to chdir to userData:", err);
  }
}

let mainWindow = null;
let backendServer = null;

// Enforce single-instance application lock
const gotTheLock = app.requestSingleInstanceLock();
console.log("[electron] requestSingleInstanceLock:", gotTheLock);
if (!gotTheLock) {
  console.log("Single instance lock: another instance is running. Exiting.");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function findFreePort(preferredPort = 3000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      const fallback = net.createServer();
      fallback.listen(0, "127.0.0.1", () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    srv.listen(preferredPort, "127.0.0.1", () => {
      srv.close(() => resolve(preferredPort));
    });
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      http
        .get(url, (res) => {
          if (res.statusCode === 200) resolve();
          else setTimeout(ping, 250);
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timed out waiting for backend server at ${url}`));
          } else {
            setTimeout(ping, 250);
          }
        });
    }
    ping();
  });
}

async function createWindow(port) {
  const iconPath = path.join(__dirname, "..", "frontend", "favicon.png");

  mainWindow = new BrowserWindow({
    title: "Magic Fabrica Studio",
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0B0F19",
    show: false,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Reveal window smoothly when DOM is painted
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    initAutoUpdater(mainWindow);
  });

  // Open external links (e.g. Google sign-in help, downloads) in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const appUrl = `http://127.0.0.1:${port}`;
  await mainWindow.loadURL(appUrl);
}

async function startApplication() {
  console.log("[electron] startApplication() triggered");
  try {
    const port = await findFreePort(3000);
    console.log("[electron] Port selected:", port);
    process.env.APP_PORT = String(port);

    console.log("[electron] Dynamically importing backend...");
    const backend = await import("../backend/index.js");
    backendServer = backend;
    console.log("[electron] Backend imported successfully!");

    console.log("[electron] Waiting for health endpoint...");
    await waitForServer(`http://127.0.0.1:${port}/api/health`);
    console.log("[electron] Health endpoint responded! Creating window...");

    await createWindow(port);
    console.log("[electron] Window created!");
  } catch (err) {
    const msg = err?.stack || String(err);
    console.error("[electron] Failed to launch application:", msg);
    try {
      fs.writeFileSync(path.join(process.cwd(), "startup-launch-error.log"), msg);
    } catch (_) {}
    try {
      dialog.showErrorBox("Startup Launch Error", msg);
    } catch (_) {}
    app.quit();
  }
}

app.whenReady().then(startApplication);

app.on("window-all-closed", async () => {
  if (backendServer && typeof backendServer.shutdown === "function") {
    try {
      await backendServer.shutdown();
    } catch (_) {}
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && process.env.APP_PORT) {
    createWindow(Number(process.env.APP_PORT));
  }
});
