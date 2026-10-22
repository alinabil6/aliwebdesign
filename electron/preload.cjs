const { contextBridge, ipcRenderer } = require("electron");

// Secure context bridge exposing desktop features to the renderer window.
// This file MUST be CommonJS (.cjs) because Electron preload scripts
// with contextIsolation:true do not support ESM when "type":"module" is
// set in package.json.
contextBridge.exposeInMainWorld("desktopAPI", {
  isDesktop: true,
  platform: process.platform,

  checkForUpdates: () => {
    ipcRenderer.send("check-for-updates");
  },

  onUpdateChecking: (callback) => {
    ipcRenderer.on("update-checking", (_event, info) => callback(info));
  },

  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on("update-not-available", (_event, info) => callback(info));
  },

  onUpdateError: (callback) => {
    ipcRenderer.on("update-error", (_event, info) => callback(info));
  },

  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("update-downloaded", (_event, info) => callback(info));
  },

  restartAndInstall: () => {
    ipcRenderer.send("restart-and-install");
  },
});
