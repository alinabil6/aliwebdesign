import { app, BrowserWindow, shell } from "electron";
import path from "path";
import net from "net";
import http from "http";
import { fileURLToPath } from "url";
import { initAutoUpdater } from "./updater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CRITICAL SAFETY SWITCH ─────────────────────────────────────
// Only packaged production desktop installers redirect paths to %APPDATA%.
// In development, MF_PACKAGED remains "0", preserving 100% local folder behavior.
process.env.MF_PACKAGED = app.isPackaged ? "1" : "0";
process.env.HOST = "127.0.0.1";

let mainWindow = null;
let backendServer = null;

// Enforce single-instance application lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
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
      preload: path.join(__dirname, "preload.js"),
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
  try {
    const port = await findFreePort(3000);
    process.env.APP_PORT = String(port);

    // Dynamically boot the Express backend
    const backend = await import("../backend/index.js");
    backendServer = backend;

    // Confirm local loopback is healthy before presenting UI
    await waitForServer(`http://127.0.0.1:${port}/api/health`);

    await createWindow(port);
  } catch (err) {
    console.error("[electron] Failed to launch application:", err);
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
