"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clanker", {
  // Desktop prefs
  getDesktopConfig: () => ipcRenderer.invoke("desktop:get-config"),
  saveDesktopConfig: (partial) => ipcRenderer.invoke("desktop:save-config", partial),
  getConnection: () => ipcRenderer.invoke("desktop:connection"),

  // Host process
  hostStatus: () => ipcRenderer.invoke("host:process-status"),
  hostStart: () => ipcRenderer.invoke("host:start"),
  hostStop: (opts) => ipcRenderer.invoke("host:stop", opts),
  hostRestart: () => ipcRenderer.invoke("host:restart"),
  hostInstall: (opts) => ipcRenderer.invoke("host:install", opts),
  hostUninstall: (opts) => ipcRenderer.invoke("host:uninstall", opts),
  hostServiceLoad: () => ipcRenderer.invoke("host:service-load"),
  hostServiceUnload: () => ipcRenderer.invoke("host:service-unload"),

  // Host gateway config.json
  getHostConfig: () => ipcRenderer.invoke("host:get-config"),
  saveHostConfig: (patch) => ipcRenderer.invoke("host:save-config", patch),
  regenerateToken: () => ipcRenderer.invoke("host:regenerate-token"),
  ensureHostConfig: () => ipcRenderer.invoke("host:ensure-config"),

  // OS helpers
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  showPath: (p) => ipcRenderer.invoke("shell:show-path", p),
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),

  // Events from main
  onHostEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("host:event", handler);
    return () => ipcRenderer.removeListener("host:event", handler);
  },
  onWsStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("host:ws-status", handler);
    return () => ipcRenderer.removeListener("host:ws-status", handler);
  },
  onHostLog: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("host:log", handler);
    return () => ipcRenderer.removeListener("host:log", handler);
  },
  onHostProcess: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("host:process", handler);
    return () => ipcRenderer.removeListener("host:process", handler);
  },
  onSessionFocus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("session:focus", handler);
    return () => ipcRenderer.removeListener("session:focus", handler);
  },

  platform: process.platform,
});
