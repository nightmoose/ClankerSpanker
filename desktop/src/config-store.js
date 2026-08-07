"use strict";

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Desktop shell preferences (not the host gateway config).
 * Host config lives at ~/.grok-dispatch/config.json.
 */
const DEFAULTS = {
  /**
   * managed — desktop owns a local host process (start/stop/settings).
   * remote  — connect to an already-running host (LAN / Tailscale / another box).
   */
  mode: "managed",
  hostURL: "http://127.0.0.1:8787",
  token: "",
  /** Absolute path to host package (contains package.json + dist/). Empty = auto-detect. */
  hostPackagePath: "",
  /** When mode=managed, start host if /health is down. */
  autoStartHost: true,
  /** If this process started the host, stop it on quit. */
  stopHostOnQuit: true,
  startMinimized: false,
  notifications: true,
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      hostURL: String(parsed.hostURL || DEFAULTS.hostURL).replace(/\/$/, ""),
      token: String(parsed.token || ""),
      mode: parsed.mode === "remote" ? "remote" : "managed",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(partial) {
  const next = {
    ...loadConfig(),
    ...partial,
  };
  if (typeof next.hostURL === "string") {
    next.hostURL = next.hostURL.trim().replace(/\/$/, "") || DEFAULTS.hostURL;
  }
  if (typeof next.token === "string") {
    next.token = next.token.trim();
  }
  if (next.mode !== "remote") next.mode = "managed";
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function isConfigured(config = loadConfig()) {
  if (config.mode === "managed") return true; // local host can mint a token on first start
  return Boolean(config.hostURL && config.token);
}

module.exports = {
  DEFAULTS,
  configPath,
  loadConfig,
  saveConfig,
  isConfigured,
};
