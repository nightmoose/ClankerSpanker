"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clanker", {
  // Desktop prefs
  getDesktopConfig: () => ipcRenderer.invoke("desktop:get-config"),
  saveDesktopConfig: (partial) => ipcRenderer.invoke("desktop:save-config", partial),
  getConnection: () => ipcRenderer.invoke("desktop:connection"),
  /** RFC-025: per-host connection map for renderer fan-out. */
  getConnections: () => ipcRenderer.invoke("desktop:connections"),

  // Multi-host registry
  saveHost: (patch) => ipcRenderer.invoke("desktop:host-save", patch),
  removeHost: (id) => ipcRenderer.invoke("desktop:host-remove", id),
  setActiveHost: (id) => ipcRenderer.invoke("desktop:host-activate", id),

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
  pickDirectories: () => ipcRenderer.invoke("dialog:pick-directories"),
  pickFiles: (opts) => ipcRenderer.invoke("dialog:pick-files", opts),
  readLocalFile: (target) => ipcRenderer.invoke("fs:read-file", target),

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
  onApprovalAction: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("session:approval-action", handler);
    return () => ipcRenderer.removeListener("session:approval-action", handler);
  },
  onDesktopConfig: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("desktop:config", handler);
    return () => ipcRenderer.removeListener("desktop:config", handler);
  },

  platform: process.platform,
});
