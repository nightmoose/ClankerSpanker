import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BUSY = new Set(["queued", "running", "awaiting_approval", "awaiting_question"]);

export type UpdateState =
  | "current"
  | "behind"
  | "ahead"
  | "diverged"
  | "dirty"
  | "missing"
  | "no-upstream"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  repoDir: string | null;
  branch: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  summary: string;
  checkedAt: string;
  autoUpdate: boolean;
  /** Clean fast-forward of the current upstream. Never a reset, never a branch switch. */
  canApply: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export async function defaultGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1_000_000,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function isCheckout(dir: string, exists: (p: string) => boolean): boolean {
  return exists(join(dir, ".git")) && exists(join(dir, "host", "package.json"));
}

/** Configured path wins. Otherwise env, ~/Projects/GrokDispatch, then walk up from the running file. */
export function resolveRepoDir(opts: {
  configured?: string;
  env?: string;
  home?: string;
  argv1?: string;
  exists?: (p: string) => boolean;
}): { dir: string | null; error?: string } {
  const exists = opts.exists ?? existsSync;
  const configured = opts.configured?.trim();
  if (configured) {
    if (isCheckout(configured, exists)) return { dir: configured };
    return { dir: null, error: `repoDir is not a ClankerSpanker checkout: ${configured}` };
  }
  const candidates = [opts.env?.trim(), join(opts.home ?? homedir(), "Projects", "GrokDispatch")].filter(
    (p): p is string => !!p,
  );
  for (const c of candidates) {
    if (isCheckout(c, exists)) return { dir: c };
  }
  let dir = opts.argv1 ? dirname(opts.argv1) : "";
  for (let i = 0; dir && i < 8; i++) {
    if (isCheckout(dir, exists)) return { dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: null, error: "No ClankerSpanker checkout found. Set repoDir in ~/.grok-dispatch/config.json." };
}

/** App-install root when this process is the copied host, not the checkout. */
export function appInstallRoot(argv1: string): string | null {
  const norm = argv1.replace(/\\/g, "/");
  const markers = [
    "/Library/Application Support/ClankerSpanker/host/",
    "/.local/share/clankerspanker/host/",
  ];
  for (const marker of markers) {
    const at = norm.indexOf(marker);
    if (at < 0) continue;
    return argv1.slice(0, at + marker.length - 1);
  }
  return null;
}

export function classifyUpdate(input: {
  repoDir: string | null;
  branch?: string | null;
  upstream?: string | null;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  error?: string;
  autoUpdate?: boolean;
}): UpdateStatus {
  const checkedAt = new Date().toISOString();
  const base = {
    repoDir: input.repoDir,
    branch: input.branch ?? null,
    upstream: input.upstream ?? null,
    behind: input.behind ?? 0,
    ahead: input.ahead ?? 0,
    dirty: !!input.dirty,
    checkedAt,
    autoUpdate: !!input.autoUpdate,
    canApply: false,
  };
  if (!input.repoDir) {
    return { ...base, state: "missing", summary: input.error || "No checkout to update from." };
  }
  if (input.error) {
    return { ...base, state: "error", summary: input.error };
  }
  if (input.dirty) {
    return {
      ...base,
      state: "dirty",
      summary: "Checkout has uncommitted work. Commit or stash it before updating. Nothing was changed.",
    };
  }
  if (!input.upstream) {
    return {
      ...base,
      state: "no-upstream",
      summary: `Branch ${input.branch || "(unknown)"} has no upstream. Set one, or check out a branch that tracks origin.`,
    };
  }
  const ahead = input.ahead ?? 0;
  const behind = input.behind ?? 0;
  if (ahead > 0 && behind > 0) {
    return {
      ...base,
      state: "diverged",
      summary: `${input.branch} has diverged from ${input.upstream} (${ahead} ahead, ${behind} behind). Not fast-forwarding.`,
    };
  }
  if (ahead > 0) {
    return {
      ...base,
      state: "ahead",
      summary: `${input.branch} is ${ahead} commit(s) ahead of ${input.upstream}. Nothing to pull.`,
    };
  }
  if (behind > 0) {
    return {
      ...base,
      state: "behind",
      canApply: true,
      summary: `${behind} commit(s) behind ${input.upstream}. A fast-forward will build and restart the host.`,
    };
  }
  return { ...base, state: "current", summary: `Up to date with ${input.upstream}.` };
}

export async function inspectUpdate(opts: {
  repoDir: string | null;
  error?: string;
  fetch?: boolean;
  autoUpdate?: boolean;
  run?: GitRunner;
}): Promise<UpdateStatus> {
  if (!opts.repoDir) return classifyUpdate({ repoDir: null, error: opts.error, autoUpdate: opts.autoUpdate });
  const run = opts.run ?? defaultGit;
  const repo = opts.repoDir;
  if (opts.fetch) {
    const fetched = await run(["fetch", "--prune", "origin"], repo);
    if (fetched.code !== 0) {
      return classifyUpdate({
        repoDir: repo,
        autoUpdate: opts.autoUpdate,
        error: `git fetch failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`,
      });
    }
  }
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim();
  const upstreamRun = await run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repo);
  const upstream = upstreamRun.code === 0 ? upstreamRun.stdout.trim() : null;
  const dirty = (await run(["status", "--porcelain"], repo)).stdout.trim().length > 0;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repo);
    if (counts.code !== 0) {
      return classifyUpdate({
        repoDir: repo,
        branch,
        upstream,
        dirty,
        autoUpdate: opts.autoUpdate,
        error: `git rev-list failed: ${(counts.stderr || counts.stdout).trim().slice(0, 300)}`,
      });
    }
    const [a, b] = counts.stdout.trim().split(/\s+/);
    ahead = Number(a) || 0;
    behind = Number(b) || 0;
  }
  return classifyUpdate({
    repoDir: repo,
    branch,
    upstream,
    dirty,
    ahead,
    behind,
    autoUpdate: opts.autoUpdate,
  });
}

/** Static script. Paths arrive as env vars so a weird path cannot break out of quotes. */
export function updateScript(): string {
  return `#!/bin/bash
set -euo pipefail
: "\${REPO:?}"
: "\${DATA:?}"
# LaunchAgents start with a short PATH. Keep whatever they already had, and
# add the locations installers actually put node, npm, and git.
export PATH="\${HOME:-}/.grok/bin:\${HOME:-}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\${PATH:-}"
LOG="$DATA/self-update.log"
LOCK="$DATA/self-update.lock"
mkdir -p "$DATA"
exec >>"$LOG" 2>&1
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) self-update ==="
# Lock before sleeping so a second request cannot start a second build.
if ! mkdir "$LOCK.d" 2>/dev/null; then
  old=$(cat "$LOCK" 2>/dev/null || true)
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "already running (pid $old)"
    exit 2
  fi
  echo "stale lock (pid \${old:-none}); taking over"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"; rmdir "$LOCK.d" 2>/dev/null || true' EXIT
sleep 1
cd "$REPO"
git pull --ff-only
cd "$REPO/host"
npm install --no-audit --no-fund
npm run build
if [[ -n "\${INSTALL_ROOT:-}" ]]; then
  mkdir -p "$INSTALL_ROOT"
  rsync -a dist web package.json package-lock.json "$INSTALL_ROOT/"
  (cd "$INSTALL_ROOT" && npm install --omit=dev --no-audit --no-fund)
fi
uid=$(id -u)
if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$uid/com.nightmoose.clankerspanker-host" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$uid/com.nightmoose.clankerspanker-host"
elif command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$uid/com.nightmoose.grok-dispatch-host" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$uid/com.nightmoose.grok-dispatch-host"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet clankerspanker-host.service; then
  systemctl --user restart clankerspanker-host.service
else
  echo "build finished; no LaunchAgent or systemd unit is loaded, so the process was not restarted"
fi
`;
}

export function hostIsBusy(statuses: string[]): boolean {
  return statuses.some((s) => BUSY.has(s));
}

export interface ApplyResult {
  ok: boolean;
  started?: boolean;
  logPath?: string;
  error?: string;
  status: UpdateStatus;
  busy: boolean;
}

export function startUpdateController(opts: {
  repoDir?: string;
  autoUpdate?: boolean;
  dataDir: string;
  argv1?: string;
  home?: string;
  envRepo?: string;
  busy?: () => boolean;
  intervalMs?: number;
  /** Delay before the first fetch. `0` skips the boot check (tests). */
  bootDelayMs?: number;
  run?: GitRunner;
  spawnImpl?: (scriptPath: string, env: NodeJS.ProcessEnv) => void;
  /** Test seam. Production tracks the detached script's pid. */
  updaterAlive?: () => boolean;
}): {
  check(opts?: { fetch?: boolean; auto?: boolean }): Promise<UpdateStatus>;
  apply(): Promise<ApplyResult>;
  stop(): void;
} {
  const ttlMs = 10 * 60_000;
  const intervalMs = opts.intervalMs ?? 30 * 60_000;
  let cached: UpdateStatus | null = null;
  let inflight: Promise<UpdateStatus> | null = null;
  let applying = false;
  let updaterPid: number | null = null;

  function updaterAlive(): boolean {
    if (opts.updaterAlive) return opts.updaterAlive();
    if (updaterPid == null) return false;
    try {
      process.kill(updaterPid, 0);
      return true;
    } catch {
      updaterPid = null;
      return false;
    }
  }

  const resolved = () =>
    resolveRepoDir({
      configured: opts.repoDir,
      env: opts.envRepo,
      home: opts.home,
      argv1: opts.argv1 ?? process.argv[1],
    });

  async function check(req?: { fetch?: boolean; auto?: boolean }): Promise<UpdateStatus> {
    const fresh =
      req?.fetch === true || !cached || Date.now() - Date.parse(cached.checkedAt) > ttlMs;
    if (!fresh && cached && !req?.auto) return cached;
    if (inflight && !req?.auto) return inflight;
    const found = resolved();
    const job = inspectUpdate({
      repoDir: found.dir,
      error: found.error,
      fetch: req?.fetch !== false && (req?.fetch === true || !cached),
      autoUpdate: !!opts.autoUpdate,
      run: opts.run,
    });
    inflight = job;
    try {
      cached = await job;
    } finally {
      if (inflight === job) inflight = null;
    }
    if (req?.auto && opts.autoUpdate && cached.canApply && !applying && !updaterAlive() && !opts.busy?.()) {
      await apply();
    }
    return cached;
  }

  async function apply(): Promise<ApplyResult> {
    if (applying || updaterAlive()) {
      const status =
        cached ??
        (await check({ fetch: false }));
      return { ok: false, error: "An update is already running.", status, busy: !!opts.busy?.() };
    }
    applying = true;
    try {
      const status = await check({ fetch: true });
      const busy = !!opts.busy?.();
      if (!status.canApply || !status.repoDir) {
        return { ok: false, error: status.summary, status, busy };
      }
      const logPath = join(opts.dataDir, "self-update.log");
      mkdirSync(opts.dataDir, { recursive: true });
      const scriptPath = join(opts.dataDir, "self-update.sh");
      writeFileSync(scriptPath, updateScript(), { mode: 0o700 });
      chmodSync(scriptPath, 0o700);
      const installRoot = appInstallRoot(opts.argv1 ?? process.argv[1] ?? "") ?? "";
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        REPO: status.repoDir,
        DATA: opts.dataDir,
        INSTALL_ROOT: installRoot,
      };
      if (opts.spawnImpl) opts.spawnImpl(scriptPath, env);
      else {
        const child = spawn("bash", [scriptPath], { detached: true, stdio: "ignore", env });
        updaterPid = child.pid ?? null;
        child.unref();
        console.log(
          `[update] fast-forward started (${status.behind} behind ${status.upstream ?? "upstream"}); log ${logPath}`,
        );
      }
      return {
        ok: true,
        started: true,
        logPath,
        status,
        busy,
      };
    } catch (err) {
      const status =
        cached ??
        classifyUpdate({ repoDir: null, error: "Update failed before it started.", autoUpdate: !!opts.autoUpdate });
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status,
        busy: !!opts.busy?.(),
      };
    } finally {
      applying = false;
    }
  }

  const timer = setInterval(() => {
    void check({ fetch: true, auto: true }).catch((err) => {
      console.error("[update]", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  timer.unref?.();
  const bootDelay = opts.bootDelayMs ?? 5_000;
  const boot =
    bootDelay > 0
      ? setTimeout(() => {
          void check({ fetch: true, auto: true }).catch((err) => {
            console.error("[update]", err instanceof Error ? err.message : err);
          });
        }, bootDelay)
      : undefined;
  boot?.unref?.();

  return {
    check,
    apply,
    stop() {
      clearInterval(timer);
      if (boot) clearTimeout(boot);
    },
  };
}
