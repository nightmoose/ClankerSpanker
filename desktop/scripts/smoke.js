#!/usr/bin/env node
"use strict";

/**
 * RFC-066 smoke check for the Electron shell. Runs under plain Node on any OS,
 * no display and no Electron binary:
 *
 *   1. `node --check` over every main-process and renderer script.
 *   2. Load src/main.js and src/preload.js with `electron` mocked, then assert
 *      the window keeps contextIsolation on, nodeIntegration off and sandbox on,
 *      and that every channel the preload invokes has a main-process handler.
 *
 * HOME and userData point at a throwaway directory, and the only host is a
 * remote one on a closed port, so nothing is spawned and no real config is read
 * or written.
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

// --- 1. Syntax ---------------------------------------------------------------

const sources = ["src", "renderer"].flatMap((dir) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(root, dir, f)),
);
for (const file of sources) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`[smoke] syntax ok: ${sources.length} files`);

// --- 2. Load main + preload against a mocked electron ------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-desktop-smoke-"));
process.env.HOME = tmp;
process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
process.env.XDG_DATA_HOME = path.join(tmp, ".local", "share");
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(
  path.join(userData, "config.json"),
  JSON.stringify({
    hosts: [{ id: "smoke", name: "Smoke", mode: "remote", hostURL: "http://127.0.0.1:9", token: "" }],
    activeHostId: "smoke",
    autoStartHost: false,
    notifications: false,
  }),
);

/** Callable, constructible stub; any property not set on it is another stub. */
function stub() {
  const target = function () {};
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(t, prop)) return t[prop];
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return stub();
    },
    apply: () => stub(),
    construct: () => stub(),
  });
}

const windows = [];
const handled = new Set();
const exposed = {};
const invoked = new Set();

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.webContents = stub();
    windows.push(this);
  }
  static getFocusedWindow() {
    return null;
  }
  static getAllWindows() {
    return windows;
  }
  isDestroyed() {
    return false;
  }
}
for (const m of ["on", "once", "loadFile", "loadURL", "show", "hide", "focus", "restore", "isVisible", "isMinimized"]) {
  FakeBrowserWindow.prototype[m] = function () {
    return m.startsWith("is") ? false : undefined;
  };
}

const electronMock = {
  app: Object.assign(stub(), {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    on() {},
    once() {},
    quit() {},
    exit() {},
    isPackaged: false,
    getVersion: () => "0.0.0-smoke",
  }),
  BrowserWindow: FakeBrowserWindow,
  Tray: stub(),
  Menu: stub(),
  nativeImage: stub(),
  Notification: Object.assign(stub(), { isSupported: () => false }),
  ipcMain: {
    handle: (channel) => handled.add(channel),
    on: (channel) => handled.add(channel),
  },
  shell: stub(),
  dialog: stub(),
  contextBridge: {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    },
  },
  ipcRenderer: {
    invoke: (channel) => {
      invoked.add(channel);
      return Promise.resolve();
    },
    on() {},
    removeListener() {},
  },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, ...rest);
};

require(path.join(root, "src", "main.js"));
require(path.join(root, "src", "preload.js"));

async function main() {
  // Let app.whenReady().then(...) run to completion.
  for (let i = 0; i < 20 && windows.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

  assert.equal(windows.length, 1, "main window was not created");
  const prefs = windows[0].options.webPreferences;
  assert.equal(prefs.contextIsolation, true, "contextIsolation must stay on");
  assert.equal(prefs.nodeIntegration, false, "nodeIntegration must stay off");
  assert.equal(prefs.sandbox, true, "sandbox must stay on");
  assert.ok(prefs.preload && fs.existsSync(prefs.preload), "preload path missing");
  console.log("[smoke] main window: contextIsolation on, nodeIntegration off, sandbox on");

  assert.ok(exposed.clanker, "preload did not expose window.clanker");
  for (const fn of Object.values(exposed.clanker)) {
    // Invoke every bridge method once to learn its channel; listeners just subscribe.
    if (typeof fn === "function") fn(() => {});
  }
  const missing = [...invoked].filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], `preload invokes channels with no ipcMain handler: ${missing.join(", ")}`);
  console.log(`[smoke] preload: ${invoked.size} invoke channels, all handled in main`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("[smoke] ok");
  // The host WebSocket pool keeps retrying the closed port; we're done.
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
