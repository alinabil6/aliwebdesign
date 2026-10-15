import { app, dialog, ipcMain } from "electron";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

/**
 * Initializes automatic background updates via GitHub Releases.
 * Only runs in packaged production builds.
 */
export function initAutoUpdater(mainWindow) {
  if (!app.isPackaged) {
    console.log("[updater] Running in development mode — auto-update check skipped.");
    return;
  }

  let autoUpdater;
  try {
    const updaterModule = require("electron-updater");
    autoUpdater = updaterModule.autoUpdater;
  } catch (err) {
    console.warn("[updater] electron-updater module not available:", err.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for new release on GitHub...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] New update available: v${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-available", {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] App is up to date.");
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] Auto-updater encountered an error:", err.message);
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] Update v${info.version} downloaded and ready to install.`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-downloaded", {
        version: info.version,
      });

      dialog
        .showMessageBox(mainWindow, {
          type: "info",
          title: "Update Ready",
          message: `Magic Fabrica v${info.version} is downloaded and ready to install.`,
          detail: "Restart now to apply the update, or install automatically when closing the app.",
          buttons: ["Restart Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall(false, true);
          }
        })
        .catch(() => {});
    }
  });

  ipcMain.on("restart-and-install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Check on boot after 5 seconds, then check every 4 hours
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn("[updater] Initial update check failed:", err.message);
    });
  }, 5000);

  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}
