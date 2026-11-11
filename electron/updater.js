import { app, dialog, ipcMain } from "electron";
import { createRequire } from "module";

// Use createRequire to load electron-updater (CJS-only package, no ESM exports field)
// from inside the ESM Electron main process context.
const require = createRequire(import.meta.url);

function formatUpdaterError(err) {
  const raw = String(err?.message || err || "Unable to check for updates");
  if (/cannot find latest(?:-mac)?\.yml|status(?:Code)?[: ]*404|HttpError:\s*404/i.test(raw)) {
    return "Update files are still syncing on GitHub — please try again in a minute.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(raw)) {
    return "Could not reach GitHub — check your internet connection.";
  }
  return raw.split(/\r?\n/)[0].trim().slice(0, 140) || "Unable to check for updates";
}

/**
 * Initializes automatic background updates via GitHub Releases.
 * Only activates in the packaged production build — never in local development.
 */
export function initAutoUpdater(mainWindow) {
  if (!app.isPackaged) {
    console.log("[updater] Development mode — auto-update check skipped.");
    ipcMain.on("check-for-updates", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-not-available", {
          devMode: true,
          message: "Running in local development mode — auto-updates only run in packaged builds.",
        });
      }
    });
    return;
  }

  let autoUpdater;
  try {
    const { autoUpdater: au } = require("electron-updater");
    autoUpdater = au;
  } catch (err) {
    console.warn("[updater] electron-updater not available:", err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  let isChecking = false;
  let isManualCheck = false;

  const runUpdateCheck = async (manual = false) => {
    if (isChecking) return;
    isChecking = true;
    isManualCheck = manual;
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      console.warn("[updater] Check failed:", formatUpdaterError(err));
    } finally {
      isChecking = false;
      isManualCheck = false;
    }
  };

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking GitHub Releases for updates...");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-checking");
    }
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] New version available: v${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-available", {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] App is up to date.");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-not-available", {
        version: info?.version,
      });
    }
  });

  autoUpdater.on("error", (err) => {
    const friendly = formatUpdaterError(err);
    console.error("[updater] Update check error:", friendly);
    // Only surface updater errors on explicit manual checks; background checks
    // retry quietly every 4 hours so transient GitHub release sync delays never nag.
    if (isManualCheck && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-error", { error: friendly });
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    if (pct % 10 === 0) console.log(`[updater] Downloading update: ${pct}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] Update v${info.version} ready to install.`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-downloaded", { version: info.version });

      dialog
        .showMessageBox(mainWindow, {
          type: "info",
          title: "Update Ready",
          message: `Magic Fabrica v${info.version} is ready to install.`,
          detail: "Restart now to apply the update, or it will be applied automatically when you close the app.",
          buttons: ["Restart Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall(false, true);
        })
        .catch(() => {});
    }
  });

  ipcMain.on("check-for-updates", () => {
    console.log("[updater] User requested manual update check.");
    runUpdateCheck(true);
  });

  ipcMain.on("restart-and-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Check on launch (after a short delay to let the UI settle), then every 4 hours
  setTimeout(() => runUpdateCheck(false), 4000);

  setInterval(() => runUpdateCheck(false), 4 * 60 * 60 * 1000);
}
