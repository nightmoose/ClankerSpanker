"use strict";

const { app } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Desktop shell preferences (not the host gateway config).
 * Host config lives at ~/.grok-dispatch/config.json.
 */
const DEFAULTS = {
  hosts: [
    {
      id: "local",
      name: "Local",
      mode: "managed",
      hostURL: "http://127.0.0.1:8787",
      token: "",
    },
  ],
  activeHostId: "local",
  /** Absolute path to host package (contains package.json + dist/). Empty = auto-detect. */
  hostPackagePath: "",
  /** When active host is managed, start it if /health is down. */
  autoStartHost: true,
  /** If this process started the host, stop it on quit. */
  stopHostOnQuit: true,
  startMinimized: false,
  notifications: true,
};

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function newHostId() {
  return `host_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeHost(h, i = 0) {
  const mode = h?.mode === "remote" ? "remote" : "managed";
  return {
    id: h?.id || newHostId(),
    name: (h?.name || (i === 0 ? "Local" : `Host ${i + 1}`)).toString().trim(),
    mode,
    hostURL: String(h?.hostURL || "http://127.0.0.1:8787").trim().replace(/\/$/, ""),
    token: String(h?.token || "").trim(),
  };
}

function migrate(parsed) {
  if (Array.isArray(parsed.hosts) && parsed.hosts.length) {
    const hosts = parsed.hosts.map((h, i) => normalizeHost(h, i));
    const activeHostId = hosts.some((h) => h.id === parsed.activeHostId)
      ? parsed.activeHostId
      : hosts[0].id;
    return { hosts, activeHostId };
  }
  // Legacy single-host schema — migrate mode/hostURL/token into a single host.
  const host = normalizeHost({
    id: "local",
    name: "Local",
    mode: parsed.mode === "remote" ? "remote" : "managed",
    hostURL: parsed.hostURL || DEFAULTS.hosts[0].hostURL,
    token: parsed.token || "",
  });
  return { hosts: [host], activeHostId: host.id };
}

function loadConfig() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    parsed = {};
  }
  const { hosts, activeHostId } = migrate(parsed);
  return {
    ...DEFAULTS,
    ...parsed,
    hosts,
    activeHostId,
  };
}

function saveConfig(partial) {
  const current = loadConfig();
  const next = { ...current, ...partial };
  const { hosts, activeHostId } = migrate(next);
  next.hosts = hosts;
  next.activeHostId = activeHostId;

  // Legacy fields removed on write — the migrator handles read-time back-compat.
  delete next.mode;
  delete next.hostURL;
  delete next.token;

  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function getActiveHost(config = loadConfig()) {
  return config.hosts.find((h) => h.id === config.activeHostId) || config.hosts[0];
}

function upsertHost(patch) {
  const config = loadConfig();
  const hosts = [...config.hosts];
  let id = patch.id;
  if (id) {
    const i = hosts.findIndex((h) => h.id === id);
    if (i === -1) {
      hosts.push(normalizeHost({ ...patch, id }, hosts.length));
    } else {
      hosts[i] = normalizeHost({ ...hosts[i], ...patch }, i);
    }
  } else {
    id = newHostId();
    hosts.push(normalizeHost({ ...patch, id }, hosts.length));
  }
  return { ...saveConfig({ hosts }), _newHostId: id };
}

function removeHost(id) {
  const config = loadConfig();
  if (config.hosts.length <= 1) throw new Error("Cannot remove the last host");
  const hosts = config.hosts.filter((h) => h.id !== id);
  const activeHostId = config.activeHostId === id ? hosts[0].id : config.activeHostId;
  return saveConfig({ hosts, activeHostId });
}

function setActiveHost(id) {
  const config = loadConfig();
  if (!config.hosts.some((h) => h.id === id)) throw new Error(`Unknown host: ${id}`);
  return saveConfig({ activeHostId: id });
}

function updateActiveHostToken(token) {
  const config = loadConfig();
  const active = getActiveHost(config);
  if (!active) return config;
  return upsertHost({ id: active.id, token });
}

function isConfigured(config = loadConfig()) {
  const active = getActiveHost(config);
  if (!active) return false;
  if (active.mode === "managed") return true;
  return Boolean(active.hostURL && active.token);
}

module.exports = {
  DEFAULTS,
  configPath,
  loadConfig,
  saveConfig,
  isConfigured,
  getActiveHost,
  upsertHost,
  removeHost,
  setActiveHost,
  updateActiveHostToken,
};
