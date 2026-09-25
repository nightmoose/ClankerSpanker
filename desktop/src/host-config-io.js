"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".grok-dispatch");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_DATA_DIR, "config.json");

function hostConfigPath(envPath) {
  return envPath || process.env.GROK_DISPATCH_CONFIG || DEFAULT_CONFIG_PATH;
}

function ensureHostConfig(configPath = hostConfigPath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const created = {
    hostToken: crypto.randomBytes(24).toString("hex"),
    bindHost: "0.0.0.0",
    bindPort: 8787,
    grokBinary: "grok",
    projects: [],
    allowCustomPaths: true,
    profiles: [
      { id: "grok", name: "Grok", backend: "grok", color: "#73b8ff" },
      { id: "claude", name: "Claude", backend: "claude", color: "#f5a524" },
    ],
    autoApproveKinds: ["read", "search", "think", "fetch"],
    notifyDesktop: true,
    dataDir: DEFAULT_DATA_DIR,
  };
  fs.writeFileSync(configPath, JSON.stringify(created, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(configPath, 0o600); // RFC-026: holds the host token + profile secrets
  return created;
}

function readHostConfig(configPath = hostConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return { path: configPath, exists: false, config: null };
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return { path: configPath, exists: true, config };
  } catch (e) {
    return {
      path: configPath,
      exists: true,
      config: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Public view for the desktop Host panel (no profile env secrets).
 */
function publicHostConfig(raw) {
  if (!raw) return null;
  const profiles = (raw.profiles || []).map((p) => ({
    id: p.id,
    name: p.name,
    backend: p.backend,
    color: p.color,
    model: p.model,
    hasCredentials: Boolean(
      p.claudeConfigDir ||
        (p.env && (p.env.ANTHROPIC_API_KEY || p.env.ANTHROPIC_AUTH_TOKEN)),
    ),
    claudeConfigDir: p.claudeConfigDir || "",
  }));
  return {
    hostToken: raw.hostToken || "",
    bindHost: raw.bindHost || "0.0.0.0",
    bindPort: Number(raw.bindPort || 8787),
    grokBinary: raw.grokBinary || "grok",
    projects: raw.projects || [],
    allowCustomPaths: raw.allowCustomPaths !== false,
    autoApproveKinds: raw.autoApproveKinds || [],
    notifyDesktop: raw.notifyDesktop !== false,
    dataDir: raw.dataDir || DEFAULT_DATA_DIR,
    profiles,
  };
}

/**
 * Patch host config.json. Never deletes unknown keys.
 * For profiles: merge by id; only set env keys when non-empty strings provided.
 */
function writeHostConfigPatch(patch, configPath = hostConfigPath()) {
  const current = ensureHostConfig(configPath);
  const next = { ...current };

  const scalarKeys = [
    "hostToken",
    "bindHost",
    "bindPort",
    "grokBinary",
    "allowCustomPaths",
    "notifyDesktop",
    "dataDir",
  ];
  for (const k of scalarKeys) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (Array.isArray(patch.autoApproveKinds)) {
    next.autoApproveKinds = patch.autoApproveKinds;
  }
  if (Array.isArray(patch.projects)) {
    next.projects = patch.projects
      .filter((p) => p && p.id && p.name && p.path)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        path: String(p.path),
      }));
  }

  if (Array.isArray(patch.profiles)) {
    const byId = new Map((current.profiles || []).map((p) => [p.id, { ...p }]));
    for (const incoming of patch.profiles) {
      if (!incoming?.id) continue;
      const prev = byId.get(incoming.id) || { id: incoming.id };
      const merged = {
        ...prev,
        id: incoming.id,
        name: incoming.name ?? prev.name ?? incoming.id,
        backend: incoming.backend ?? prev.backend ?? "grok",
        color: incoming.color ?? prev.color ?? "#73b8ff",
        model: incoming.model !== undefined ? incoming.model || undefined : prev.model,
      };
      if (incoming.claudeConfigDir !== undefined) {
        merged.claudeConfigDir = incoming.claudeConfigDir || undefined;
      }
      // Only overwrite env secrets when caller sends non-empty values
      if (incoming.env && typeof incoming.env === "object") {
        merged.env = { ...(prev.env || {}) };
        for (const [ek, ev] of Object.entries(incoming.env)) {
          if (typeof ev === "string" && ev.length > 0) {
            merged.env[ek] = ev;
          }
        }
      }
      byId.set(incoming.id, merged);
    }
    next.profiles = [...byId.values()];
  }

  if (typeof next.bindPort === "string") next.bindPort = Number(next.bindPort);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(configPath, 0o600); // RFC-026: holds the host token + profile secrets
  return publicHostConfig(next);
}

function regenerateHostToken(configPath = hostConfigPath()) {
  const token = crypto.randomBytes(24).toString("hex");
  writeHostConfigPatch({ hostToken: token }, configPath);
  return token;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  hostConfigPath,
  ensureHostConfig,
  readHostConfig,
  publicHostConfig,
  writeHostConfigPatch,
  regenerateHostToken,
};
