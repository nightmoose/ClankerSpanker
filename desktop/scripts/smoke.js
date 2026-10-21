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
const openedExternal = [];

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    const contents = stub();
    contents.getURL = () => "file:///tmp/renderer/index.html";
    contents.setWindowOpenHandler = (fn) => {
      contents.openHandler = fn;
    };
    contents.navigateHandlers = [];
    contents.on = (event, fn) => {
      if (event === "will-navigate") contents.navigateHandlers.push(fn);
    };
    contents.once = () => {};
    contents.send = () => {};
    this.webContents = contents;
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
  shell: Object.assign(stub(), {
    openExternal: (url) => {
      openedExternal.push(url);
      return Promise.resolve();
    },
  }),
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

  const { classifyNavigation } = require(path.join(root, "src", "navigation-guard.js"));
  const page = "file:///tmp/renderer/index.html";
  assert.deepEqual(classifyNavigation(page, "file:///tmp/renderer/app.js"), { inApp: true, openExternal: false });
  assert.deepEqual(classifyNavigation(page, "file:///tmp/renderer/index.html#settings"), {
    inApp: true,
    openExternal: false,
  });
  assert.deepEqual(classifyNavigation(page, "file:///etc/passwd"), { inApp: false, openExternal: false });
  assert.deepEqual(classifyNavigation(page, "file:///tmp/renderer/../etc/passwd"), {
    inApp: false,
    openExternal: false,
  });
  assert.deepEqual(classifyNavigation(page, "https://example.com/docs"), { inApp: false, openExternal: true });
  assert.deepEqual(classifyNavigation(page, "javascript:alert(1)"), { inApp: false, openExternal: false });
  assert.deepEqual(classifyNavigation("https://app.example/index.html", "https://app.example/settings"), {
    inApp: true,
    openExternal: false,
  });
  assert.deepEqual(classifyNavigation("https://app.example/index.html", "https://evil.example/"), {
    inApp: false,
    openExternal: true,
  });
  assert.deepEqual(classifyNavigation("", "file:///tmp/renderer/index.html"), { inApp: true, openExternal: false });

  const wc = windows[0].webContents;
  assert.equal(typeof wc.openHandler, "function", "setWindowOpenHandler was not installed");
  assert.equal(wc.navigateHandlers.length, 1, "will-navigate guard was not installed");

  assert.deepEqual(wc.openHandler({ url: "https://example.com/docs" }), { action: "deny" });
  assert.deepEqual(openedExternal, ["https://example.com/docs"]);
  openedExternal.length = 0;
  assert.deepEqual(wc.openHandler({ url: "file:///tmp/renderer/app.js" }), { action: "deny" });
  assert.deepEqual(openedExternal, [], "same-app popup must not be opened externally");

  const off = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.navigateHandlers[0](off, "https://evil.example/phish");
  assert.equal(off.prevented, true, "off-origin navigation must be cancelled");
  assert.deepEqual(openedExternal, ["https://evil.example/phish"]);

  openedExternal.length = 0;
  const stay = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.navigateHandlers[0](stay, "file:///tmp/renderer/index.html#settings");
  assert.equal(stay.prevented, false, "in-app navigation must be allowed");
  assert.deepEqual(openedExternal, []);

  const script = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.navigateHandlers[0](script, "javascript:alert(1)");
  assert.equal(script.prevented, true);
  assert.deepEqual(openedExternal, [], "javascript: must not be opened externally");
  console.log("[smoke] navigation: popups denied, off-origin http(s) opens externally");

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
