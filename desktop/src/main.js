"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
  shell,
  dialog,
} = require("electron");
const path = require("node:path");
const {
  loadConfig,
  saveConfig,
  configPath,
  getActiveHost,
  upsertHost,
  removeHost,
  setActiveHost,
  updateActiveHostToken,
} = require("./config-store");
const { HostWsMonitor } = require("./host-ws");
const { HostProcessManager } = require("./host-process");
const {
  ensureHostConfig,
  readHostConfig,
  publicHostConfig,
  writeHostConfigPatch,
  regenerateHostToken,
  hostConfigPath,
} = require("./host-config-io");
const hostInstaller = require("./host-installer.js");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {'offline' | 'connecting' | 'live'} */
let connStatus = "offline";
/** @type {HostWsMonitor | null} */
let monitor = null;
const hostProc = new HostProcessManager();

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
}

function iconPath() {
  return path.join(__dirname, "..", "resources", "icon.png");
}

function trayIcon() {
  const img = nativeImage.createFromPath(iconPath());
  if (img.isEmpty()) return nativeImage.createEmpty();
  return img.resize({ width: isMac ? 18 : 24, height: isMac ? 18 : 24 });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushDesktopConfig() {
  sendToRenderer("desktop:config", loadConfig());
}

function syncTokenFromHostFile() {
  const active = getActiveHost();
  if (!active || active.mode !== "managed") return loadConfig();
  const { config } = readHostConfig();
  if (!config?.hostToken) return loadConfig();
  const port = config.bindPort || 8787;
  updateActiveHostToken(config.hostToken);
  return upsertHost({ id: active.id, hostURL: `http://127.0.0.1:${port}` });
}

function effectiveConnection() {
  const active = getActiveHost();
  if (!active) return { hostURL: "", token: "" };
  if (active.mode === "managed") {
    const { config } = readHostConfig();
    const port = config?.bindPort || 8787;
    return {
      hostURL: `http://127.0.0.1:${port}`,
      token: active.token || config?.hostToken || "",
    };
  }
  return { hostURL: active.hostURL, token: active.token };
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "ClankerSpanker",
    backgroundColor: "#0b0b10",
    show: false,
    autoHideMenuBar: !isMac,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!loadConfig().startMinimized) mainWindow?.show();
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return mainWindow;
}

function showMain() {
  const win = createMainWindow();
  win.show();
  win.focus();
}

function focusSession(sessionId) {
  showMain();
  if (sessionId) sendToRenderer("session:focus", { sessionId });
}

function setConnStatus(status) {
  connStatus = status;
  updateTrayMenu();
  sendToRenderer("host:ws-status", { status });
}

function notify(title, body, sessionId, meta) {
  if (!Notification.isSupported()) return;
  // macOS Notification supports inline "actions"; Linux libnotify does not
  // via Electron's built-in API. On both platforms the click still routes
  // to the session, and the (enriched) body carries the "what" so the user
  // can decide without opening.
  const opts = {
    title: `ClankerSpanker — ${title}`,
    body,
    icon: iconPath(),
    silent: false,
  };
  if (isMac && meta?.kind === "approval") {
    opts.actions = [{ type: "button", text: "Approve" }, { type: "button", text: "Reject" }];
  }
  const n = new Notification(opts);
  n.on("click", () => focusSession(sessionId));
  if (isMac && meta?.kind === "approval" && meta.approvalId && sessionId) {
    n.on("action", (_e, idx) => {
      showMain();
      sendToRenderer("session:approval-action", {
        sessionId,
        approvalId: meta.approvalId,
        action: idx === 0 ? "approve" : "reject",
      });
    });
  }
  n.show();
}

function updateTrayMenu() {
  if (!tray) return;
  const conn = effectiveConnection();
  const proc = hostProc.snapshot();
  const active = getActiveHost();
  const statusLabel =
    connStatus === "live" ? "Live" : connStatus === "connecting" ? "Connecting…" : "Offline";

  tray.setToolTip(`ClankerSpanker (${statusLabel})`);
  const hostSubmenu = loadConfig().hosts.map((h) => ({
    label: `${h.name}${h.id === active?.id ? "  ●" : ""}`,
    click: () => {
      setActiveHost(h.id);
      pushDesktopConfig();
      startMonitor();
      updateTrayMenu();
    },
  }));

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `ClankerSpanker — ${statusLabel}`, enabled: false },
      { label: conn.hostURL || "(no host)", enabled: false },
      {
        label: proc.running ? `Host process · pid ${proc.pid}` : "Host process · stopped",
        enabled: false,
      },
      { type: "separator" },
      { label: "Open command center", click: () => showMain() },
      { label: "Switch host", submenu: hostSubmenu.length ? hostSubmenu : [{ label: "(no hosts)", enabled: false }] },
      {
        label: "Start host",
        enabled: active?.mode === "managed" && !proc.running,
        click: () => void ipcStartHost(),
      },
      {
        label: "Stop host",
        enabled: proc.running && proc.startedByUs,
        click: () => void ipcStopHost(false),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", () => {
    if (isMac) return;
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showMain();
  });
  tray.on("double-click", () => showMain());
  updateTrayMenu();
}

function startMonitor() {
  if (monitor) monitor.stop();
  monitor = new HostWsMonitor({
    getConfig: () => {
      const c = effectiveConnection();
      return { ...c, notifications: loadConfig().notifications !== false };
    },
    onStatus: setConnStatus,
    onNotify: notify,
    onEvent: (event) => sendToRenderer("host:event", { event }),
  });
  const c = effectiveConnection();
  if (c.hostURL && c.token) monitor.start();
  else setConnStatus("offline");
  updateTrayMenu();
}

async function ipcStartHost() {
  ensureHostConfig();
  syncTokenFromHostFile();
  const active = getActiveHost();
  if (active?.mode !== "managed") {
    return { ok: false, error: "Active host is remote — start it on that machine" };
  }
  const result = await hostProc.start(loadConfig());
  if (result.ok) {
    const conn = effectiveConnection();
    for (let i = 0; i < 20; i++) {
      const probe = await hostProc.probe(conn.hostURL);
      if (probe.ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    syncTokenFromHostFile();
    startMonitor();
  }
  sendToRenderer("host:process", hostProc.snapshot());
  updateTrayMenu();
  return result;
}

async function ipcStopHost(force) {
  const result = await hostProc.stop({ force: Boolean(force) });
  startMonitor();
  sendToRenderer("host:process", hostProc.snapshot());
  updateTrayMenu();
  return result;
}

function registerIpc() {
  ipcMain.handle("desktop:get-config", () => loadConfig());
  ipcMain.handle("desktop:save-config", (_e, partial) => {
    const next = saveConfig(partial || {});
    startMonitor();
    updateTrayMenu();
    pushDesktopConfig();
    return next;
  });
  ipcMain.handle("desktop:connection", () => effectiveConnection());

  ipcMain.handle("desktop:host-save", (_e, patch) => {
    const next = upsertHost(patch || {});
    const active = getActiveHost();
    if (active?.mode === "managed") syncTokenFromHostFile();
    startMonitor();
    updateTrayMenu();
    pushDesktopConfig();
    return next;
  });
  ipcMain.handle("desktop:host-remove", (_e, id) => {
    const next = removeHost(id);
    startMonitor();
    updateTrayMenu();
    pushDesktopConfig();
    return next;
  });
  ipcMain.handle("desktop:host-activate", (_e, id) => {
    const next = setActiveHost(id);
    const active = getActiveHost();
    if (active?.mode === "managed") syncTokenFromHostFile();
    startMonitor();
    updateTrayMenu();
    pushDesktopConfig();
    return next;
  });

  ipcMain.handle("host:process-status", async () => {
    const desktop = loadConfig();
    const active = getActiveHost(desktop);
    const conn = effectiveConnection();
    const proc = hostProc.snapshot();
    const probe = await hostProc.probe(conn.hostURL);
    let service = { loaded: false, active: false, name: "" };
    try {
      service = await hostInstaller.serviceStatus();
    } catch {
      /* */
    }
    return {
      ...proc,
      mode: active?.mode || "managed",
      hostRoot: hostProc.resolveHostRoot(desktop),
      hostConfigPath: hostConfigPath(),
      probe,
      connection: conn,
      install: hostInstaller.installStatus(),
      service,
    };
  });

  ipcMain.handle("host:install", async (_e, opts) => {
    const logs = [];
    try {
      const desktop = loadConfig();
      const sourcePath = opts?.sourcePath || desktop.hostPackagePath || undefined;
      const result = await hostInstaller.installHost({
        sourcePath,
        loadService: opts?.loadService !== false,
        onLog: (line) => {
          logs.push(line);
          sendToRenderer("host:log", { line: String(line).replace(/\n$/, "") });
        },
      });
      saveConfig({ hostPackagePath: result.installRoot });
      const active = getActiveHost();
      if (active) upsertHost({ id: active.id, mode: "managed" });
      syncTokenFromHostFile();
      const conn = effectiveConnection();
      for (let i = 0; i < 25; i++) {
        const probe = await hostProc.probe(conn.hostURL);
        if (probe.ok) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      let probe = await hostProc.probe(conn.hostURL);
      if (!probe.ok) {
        await ipcStartHost();
        probe = await hostProc.probe(conn.hostURL);
      }
      startMonitor();
      pushDesktopConfig();
      return { ok: true, ...result, logs, probe };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
    }
  });

  ipcMain.handle("host:uninstall", async (_e, opts) => {
    const logs = [];
    try {
      await hostInstaller.uninstallHost({
        removeFiles: Boolean(opts?.removeFiles),
        onLog: (line) => logs.push(line),
      });
      return { ok: true, logs };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
    }
  });

  ipcMain.handle("host:service-load", async () => {
    const logs = [];
    try {
      await hostInstaller.installUserService({
        onLog: (line) => logs.push(line),
      });
      return { ok: true, logs };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
    }
  });

  ipcMain.handle("host:service-unload", async () => {
    const logs = [];
    try {
      await hostInstaller.uninstallUserService({ onLog: (line) => logs.push(line) });
      return { ok: true, logs };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), logs };
    }
  });

  ipcMain.handle("host:start", () => ipcStartHost());
  ipcMain.handle("host:stop", (_e, opts) => ipcStopHost(Boolean(opts?.force)));
  ipcMain.handle("host:restart", async () => {
    await ipcStopHost(true);
    await new Promise((r) => setTimeout(r, 400));
    return ipcStartHost();
  });

  ipcMain.handle("host:get-config", () => {
    const { path: p, exists, config, error } = readHostConfig();
    return {
      path: p,
      exists,
      error,
      config: publicHostConfig(config || (exists ? null : ensureHostConfig())),
    };
  });

  ipcMain.handle("host:save-config", (_e, patch) => {
    const published = writeHostConfigPatch(patch || {});
    syncTokenFromHostFile();
    startMonitor();
    return { ok: true, config: published, path: hostConfigPath() };
  });

  ipcMain.handle("host:regenerate-token", () => {
    const token = regenerateHostToken();
    syncTokenFromHostFile();
    startMonitor();
    return { ok: true, token };
  });

  ipcMain.handle("host:ensure-config", () => {
    const config = ensureHostConfig();
    syncTokenFromHostFile();
    return { ok: true, config: publicHostConfig(config), path: hostConfigPath() };
  });

  ipcMain.handle("shell:open-external", (_e, url) => {
    if (typeof url === "string" && /^(https?:|file:)/.test(url)) {
      return shell.openExternal(url);
    }
    return false;
  });

  ipcMain.handle("shell:show-path", (_e, target) => {
    if (typeof target === "string" && target) shell.showItemInFolder(target);
  });

  ipcMain.handle("dialog:pick-directory", async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
}

function buildAppMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Host",
      submenu: [
        {
          label: "Start host",
          click: () => void ipcStartHost(),
        },
        {
          label: "Stop host",
          click: () => void ipcStopHost(false),
        },
        {
          label: "Restart host",
          click: () => {
            void (async () => {
              await ipcStopHost(true);
              await new Promise((r) => setTimeout(r, 400));
              await ipcStartHost();
            })();
          },
        },
        { type: "separator" },
        {
          label: "Reveal host config…",
          click: () => shell.showItemInFolder(hostConfigPath()),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "Show", click: () => showMain() }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

hostProc.on("log", (line) => {
  sendToRenderer("host:log", { line });
  updateTrayMenu();
});
hostProc.on("exit", () => {
  sendToRenderer("host:process", hostProc.snapshot());
  updateTrayMenu();
  startMonitor();
});

app.whenReady().then(async () => {
  if (isLinux) app.setAppUserModelId("com.nightmoose.clankerspanker.desktop");

  registerIpc();
  buildAppMenu();
  createTray();

  const active = getActiveHost();
  if (active?.mode === "managed") {
    ensureHostConfig();
    syncTokenFromHostFile();
  }

  createMainWindow();

  const desktop = loadConfig();
  if (active?.mode === "managed" && desktop.autoStartHost !== false) {
    const conn = effectiveConnection();
    const probe = await hostProc.probe(conn.hostURL);
    if (!probe.ok) {
      const started = await hostProc.start(desktop);
      if (started.ok) {
        for (let i = 0; i < 25; i++) {
          const p = await hostProc.probe(effectiveConnection().hostURL);
          if (p.ok) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        syncTokenFromHostFile();
      }
    } else {
      hostProc.appendLog("[desktop] host already reachable; not spawning a second process");
    }
  }

  startMonitor();
  updateTrayMenu();
  console.log(`[desktop] shell config: ${configPath()}`);
  console.log(`[desktop] host config:  ${hostConfigPath()}`);

  app.on("activate", () => showMain());
});

app.on("before-quit", async (e) => {
  app.isQuitting = true;
  monitor?.stop();
  const desktop = loadConfig();
  if (desktop.stopHostOnQuit !== false && hostProc.startedByUs && hostProc.isRunning()) {
    e.preventDefault();
    await hostProc.stop({ force: true });
    app.exit(0);
  }
});

app.on("window-all-closed", () => {
  /* tray keeps process alive */
});
