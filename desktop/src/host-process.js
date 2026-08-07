"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const LOG_LIMIT = 400;

/**
 * Owns an optional local host gateway process.
 * Remote mode never spawns; managed mode can start/stop sibling `host/`.
 */
class HostProcessManager extends EventEmitter {
  constructor() {
    super();
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {string[]} */
    this.logs = [];
    /** True if this manager started the current child. */
    this.startedByUs = false;
    this._exitCode = null;
  }

  /**
   * Resolve host package root (directory with package.json name clankerspanker-host or dist/index.js).
   */
  resolveHostRoot(desktopConfig) {
    if (desktopConfig.hostPackagePath) {
      return path.resolve(desktopConfig.hostPackagePath);
    }
    // Dev: desktop/ is sibling of host/
    const sibling = path.resolve(__dirname, "..", "..", "host");
    if (fs.existsSync(path.join(sibling, "package.json"))) return sibling;

    // Packaged / alternate: cwd/host
    const cwdHost = path.resolve(process.cwd(), "host");
    if (fs.existsSync(path.join(cwdHost, "package.json"))) return cwdHost;

    return sibling;
  }

  entryScript(hostRoot) {
    const dist = path.join(hostRoot, "dist", "index.js");
    if (fs.existsSync(dist)) return dist;
    // Fall back to tsx path only if present (dev)
    const src = path.join(hostRoot, "src", "index.ts");
    if (fs.existsSync(src)) return { kind: "tsx", script: src };
    return null;
  }

  appendLog(line) {
    const text = String(line).replace(/\n$/, "");
    if (!text) return;
    this.logs.push(text);
    if (this.logs.length > LOG_LIMIT) {
      this.logs.splice(0, this.logs.length - LOG_LIMIT);
    }
    this.emit("log", text);
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  snapshot() {
    return {
      running: this.isRunning(),
      pid: this.child?.pid ?? null,
      startedByUs: this.startedByUs && this.isRunning(),
      exitCode: this._exitCode,
      logs: this.logs.slice(-120),
    };
  }

  /**
   * @param {object} desktopConfig
   * @returns {Promise<{ ok: boolean, error?: string, pid?: number }>}
   */
  async start(desktopConfig) {
    if (this.isRunning()) {
      return { ok: true, pid: this.child.pid, already: true };
    }

    const hostRoot = this.resolveHostRoot(desktopConfig);
    if (!fs.existsSync(path.join(hostRoot, "package.json"))) {
      return {
        ok: false,
        error: `Host package not found at ${hostRoot}. Set host package path in Host settings.`,
      };
    }

    const entry = this.entryScript(hostRoot);
    if (!entry) {
      return {
        ok: false,
        error: `No dist/index.js in ${hostRoot}. Run: cd host && npm run build`,
      };
    }

    let cmd;
    let args;
    if (typeof entry === "string") {
      cmd = findNodeBinary();
      args = [entry];
    } else {
      cmd = path.join(hostRoot, "node_modules", ".bin", "tsx");
      if (!fs.existsSync(cmd)) {
        return { ok: false, error: "Need host dist build (npm run build) or local tsx." };
      }
      args = [entry.script];
    }

    this.appendLog(`[desktop] starting host: ${cmd} ${args.join(" ")} (cwd=${hostRoot})`);

    try {
      this.child = spawn(cmd, args, {
        cwd: hostRoot,
        env: {
          ...process.env,
          // Ensure agent binaries are visible when launched from a GUI session
          PATH: [
            path.join(osHomedir(), ".grok", "bin"),
            path.join(osHomedir(), ".local", "bin"),
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
            process.env.PATH || "",
          ]
            .filter(Boolean)
            .join(path.delimiter),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    this.startedByUs = true;
    this._exitCode = null;
    const child = this.child;

    child.stdout?.on("data", (buf) => {
      for (const line of String(buf).split("\n")) this.appendLog(line);
    });
    child.stderr?.on("data", (buf) => {
      for (const line of String(buf).split("\n")) this.appendLog(line);
    });
    child.on("error", (err) => {
      this.appendLog(`[desktop] host spawn error: ${err.message}`);
      this.emit("exit", { code: null, error: err.message });
    });
    child.on("exit", (code, signal) => {
      this.appendLog(`[desktop] host exited code=${code} signal=${signal || ""}`);
      this._exitCode = code;
      this.child = null;
      this.startedByUs = false;
      this.emit("exit", { code, signal });
    });

    // Wait briefly for process to stay up
    await sleep(400);
    if (!this.isRunning()) {
      return {
        ok: false,
        error: "Host process exited immediately — check Host logs (build missing? port in use?)",
      };
    }
    return { ok: true, pid: child.pid };
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  async stop(opts = {}) {
    if (!this.isRunning()) {
      this.child = null;
      this.startedByUs = false;
      return { ok: true, already: true };
    }
    if (!this.startedByUs && !opts.force) {
      return {
        ok: false,
        error: "Host is running but was not started by this desktop app. Use force stop or kill it externally.",
      };
    }

    const child = this.child;
    this.appendLog("[desktop] stopping host (SIGTERM)…");
    try {
      child.kill("SIGTERM");
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const died = await waitFor(() => !this.isRunning(), 8000);
    if (!died && child) {
      this.appendLog("[desktop] host still alive — SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
      await waitFor(() => !this.isRunning(), 2000);
    }
    this.child = null;
    this.startedByUs = false;
    return { ok: true };
  }

  /**
   * Probe host HTTP health (works for managed or remote).
   */
  async probe(hostURL) {
    const base = String(hostURL || "").replace(/\/$/, "");
    if (!base) return { ok: false, error: "No host URL" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = await res.json().catch(() => ({}));
      return { ok: true, health: body };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function osHomedir() {
  return process.env.HOME || process.env.USERPROFILE || require("node:os").homedir();
}

/** Never spawn the Electron binary as Node for the host gateway. */
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

  // process.execPath is Electron when packaged — only use it for plain Node.
  if (process.execPath && !/electron/i.test(process.execPath) && fs.existsSync(process.execPath)) {
    return process.execPath;
  }

  return "node";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

module.exports = { HostProcessManager };
