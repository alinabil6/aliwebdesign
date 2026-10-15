import { contextBridge, ipcRenderer } from "electron";

// Secure context bridge exposing desktop features to the renderer window
contextBridge.exposeInMainWorld("desktopAPI", {
  isDesktop: true,
  platform: process.platform,

  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("update-downloaded", (_event, info) => callback(info));
  },

  restartAndInstall: () => {
    ipcRenderer.send("restart-and-install");
  },
});
