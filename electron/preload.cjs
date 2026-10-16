const { contextBridge, ipcRenderer } = require("electron");

// Secure context bridge exposing desktop features to the renderer window.
// This file MUST be CommonJS (.cjs) because Electron preload scripts
// with contextIsolation:true do not support ESM when "type":"module" is
// set in package.json.
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
