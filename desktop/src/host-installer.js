"use strict";

/**
 * Install the host gateway outside the git tree and wire a user service.
 * Parity with Mac Application Support + LaunchAgent:
 *   Linux:  ~/.local/share/clankerspanker/host + systemd --user
 *   macOS:  ~/Library/Application Support/ClankerSpanker/host + launchd (optional from Electron)
 *   Dev:    can still use sibling repo host/ without installing
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureHostConfig } = require("./host-config-io");

const UNIT_NAME = "clankerspanker-host.service";
const LAUNCHD_LABEL = "com.nightmoose.clankerspanker-host";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function installedHostRoot() {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "ClankerSpanker", "host");
  }
  // XDG on Linux (and fallback)
  const base = process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
  return path.join(base, "clankerspanker", "host");
}

function systemdUnitPath() {
  const conf = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(conf, "systemd", "user", UNIT_NAME);
}

function launchdPlistPath() {
  return path.join(homeDir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function isInstalled() {
  return fs.existsSync(path.join(installedHostRoot(), "dist", "index.js"));
}

function findNodeBinary() {
  const candidates = [
    process.env.npm_node_execpath,
    process.env.NODE_BINARY,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c) && !/electron/i.test(c)) return c;
  }
  return "node";
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (b) => {
      out += b;
      opts.onLog?.(String(b));
    });
    child.stderr?.on("data", (b) => {
      err += b;
      opts.onLog?.(String(b));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err, code });
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err || out}`));
    });
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function resolveSource(sourcePath) {
  if (sourcePath && fs.existsSync(path.join(sourcePath, "package.json"))) {
    return path.resolve(sourcePath);
  }
  const sibling = path.resolve(__dirname, "..", "..", "host");
  if (fs.existsSync(path.join(sibling, "package.json"))) return sibling;
  throw new Error(
    "No host source found. Point Host package path at a host/ folder with package.json (e.g. your monorepo host/).",
  );
}

/**
 * @param {{ sourcePath?: string, loadService?: boolean, onLog?: (s: string) => void }} opts
 */
async function installHost(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const src = resolveSource(opts.sourcePath);
  const dest = installedHostRoot();
  const loadService = opts.loadService !== false;

  onLog(`Source: ${src}`);
  onLog(`Install: ${dest}`);

  const distIndex = path.join(src, "dist", "index.js");
  if (!fs.existsSync(distIndex)) {
    onLog("Building host (npm install && npm run build)…");
    await run(findNodeBinary().includes("node") ? "npm" : "npm", ["install"], {
      cwd: src,
      onLog,
    }).catch(async () => {
      await run("npm", ["install"], { cwd: src, onLog });
    });
    await run("npm", ["run", "build"], { cwd: src, onLog });
  }
  if (!fs.existsSync(distIndex)) {
    throw new Error(`Build failed — missing ${distIndex}`);
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["dist", "package.json", "package-lock.json", "node_modules"]) {
    const p = path.join(dest, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  onLog("Copying dist + package manifests…");
  copyDir(path.join(src, "dist"), path.join(dest, "dist"));
  fs.copyFileSync(path.join(src, "package.json"), path.join(dest, "package.json"));
  const lock = path.join(src, "package-lock.json");
  if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(dest, "package-lock.json"));

  onLog("npm install --omit=dev…");
  await run("npm", ["install", "--omit=dev"], { cwd: dest, onLog });

  ensureHostConfig();

  if (loadService) {
    await installUserService({ hostRoot: dest, onLog });
  }

  return { ok: true, installRoot: dest };
}

async function uninstallHost(opts = {}) {
  const onLog = opts.onLog || (() => {});
  await uninstallUserService({ onLog });
  if (opts.removeFiles) {
    const dest = installedHostRoot();
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
      onLog(`Removed ${dest}`);
    }
  }
  return { ok: true };
}

async function installUserService(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const hostRoot = opts.hostRoot || installedHostRoot();
  const entry = path.join(hostRoot, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Install host package first (missing ${entry})`);
  }
  const node = findNodeBinary();
  const home = homeDir();

  if (process.platform === "linux") {
    const unitPath = systemdUnitPath();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const unit = `[Unit]
Description=ClankerSpanker host gateway (Grok Build + Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${hostRoot}
ExecStart=${node} ${entry}
Restart=on-failure
RestartSec=3
Environment=HOME=${home}
Environment=PATH=${home}/.grok/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(unitPath, unit, "utf8");
    onLog(`Wrote ${unitPath}`);
    await run("systemctl", ["--user", "daemon-reload"], { onLog });
    await run("systemctl", ["--user", "enable", "--now", UNIT_NAME], { onLog });
    onLog(`Enabled ${UNIT_NAME}`);
    return { ok: true, unit: unitPath };
  }

  if (process.platform === "darwin") {
    const plistPath = launchdPlistPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${hostRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${home}/Library/Logs/clankerspanker-host.log</string>
  <key>StandardErrorPath</key>
  <string>${home}/Library/Logs/clankerspanker-host.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${home}/.grok/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist, "utf8");
    onLog(`Wrote ${plistPath}`);
    const uid = process.getuid?.() ?? 501;
    try {
      await run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { onLog });
    } catch {
      /* not loaded */
    }
    await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { onLog });
    try {
      await run("launchctl", ["enable", `gui/${uid}/${LAUNCHD_LABEL}`], { onLog });
    } catch {
      /* */
    }
    try {
      await run("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { onLog });
    } catch {
      /* */
    }
    return { ok: true, unit: plistPath };
  }

  throw new Error(`User service install not implemented on ${process.platform}`);
}

async function uninstallUserService(opts = {}) {
  const onLog = opts.onLog || (() => {});
  if (process.platform === "linux") {
    try {
      await run("systemctl", ["--user", "disable", "--now", UNIT_NAME], { onLog });
    } catch {
      /* */
    }
    const unitPath = systemdUnitPath();
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath);
      onLog(`Removed ${unitPath}`);
    }
    try {
      await run("systemctl", ["--user", "daemon-reload"], { onLog });
    } catch {
      /* */
    }
    return { ok: true };
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    try {
      await run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { onLog });
    } catch {
      /* */
    }
    const plistPath = launchdPlistPath();
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      onLog(`Removed ${plistPath}`);
    }
    return { ok: true };
  }
  return { ok: true };
}

async function serviceStatus() {
  if (process.platform === "linux") {
    try {
      const { out } = await run("systemctl", ["--user", "is-active", UNIT_NAME]);
      return { loaded: true, active: out.trim() === "active", name: UNIT_NAME };
    } catch {
      return { loaded: fs.existsSync(systemdUnitPath()), active: false, name: UNIT_NAME };
    }
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    try {
      await run("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
      return { loaded: true, active: true, name: LAUNCHD_LABEL };
    } catch {
      return { loaded: fs.existsSync(launchdPlistPath()), active: false, name: LAUNCHD_LABEL };
    }
  }
  return { loaded: false, active: false, name: "" };
}

function installStatus() {
  return {
    installed: isInstalled(),
    installRoot: installedHostRoot(),
    platform: process.platform,
  };
}

module.exports = {
  installedHostRoot,
  isInstalled,
  installHost,
  uninstallHost,
  installUserService,
  uninstallUserService,
  serviceStatus,
  installStatus,
  UNIT_NAME,
  LAUNCHD_LABEL,
};
