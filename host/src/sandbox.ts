import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

/**
 * RFC-070. A job is sandboxed only when the caller passes the boolean true.
 * Absent, false, and the string "true" stay on the existing host path.
 */
export function sandboxRequested(value: unknown): boolean {
  return value === true;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** Directory that holds the host token and profile secrets. Never mounted. */
export function hostConfigRoot(): string {
  const cfg = process.env.GROK_DISPATCH_CONFIG?.trim();
  if (cfg) return path.resolve(path.dirname(cfg));
  return path.join(homedir(), ".grok-dispatch");
}

const BLOCKED_ENV = new Set([
  "CLAUDE_DISPATCH_TOKEN",
  "CLAUDE_DISPATCH_HOST",
  "CLAUDE_DISPATCH_SESSION_ID",
]);

/** Names a sandboxed child may keep even when they also exist on the host. */
const ALLOWED_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTIGRAVITY_CONFIG_DIR",
  "GROK_HOME",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_CONFIG_USERCONFIG",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "CI",
]);

const CONFIG_DIR_KEYS = ["CLAUDE_CONFIG_DIR", "GROK_HOME", "ANTIGRAVITY_CONFIG_DIR"] as const;

/**
 * Env for a sandboxed child. Keeps an allow-list and keys that differ from
 * the host process. Drops the rest of the host environment, including the
 * host token.
 */
export function explicitChildEnv(merged: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const src = merged ?? {};
  const out: Record<string, string> = {};
  const take = (key: string, value: string | undefined) => {
    if (typeof value !== "string" || value.length === 0) return;
    if (value.includes("\0") || value.includes("\n")) return;
    if (BLOCKED_ENV.has(key) || key.startsWith("CLAUDE_DISPATCH_") || key === "CLAUDE_APPROVAL_SOCK") {
      return;
    }
    out[key] = value;
  };
  for (const key of ALLOWED_ENV) take(key, src[key]);
  for (const [key, value] of Object.entries(src)) {
    if (process.env[key] === value) continue;
    take(key, value);
  }
  return out;
}

/** Path inside the Linux jail. The host socket is bind-mounted here, not copied. */
export const SANDBOX_APPROVAL_SOCK = "/tmp/cs-approval.sock";

export const LINUX_UNSHARE_ARGS = [
  "--user",
  "--map-root-user",
  "--mount",
  "--pid",
  "--fork",
  "--kill-child",
  "--propagation",
  "private",
] as const;

function real(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSecretRoot(p: string): boolean {
  return real(p) === real(hostConfigRoot());
}

function isInsideSecret(p: string): boolean {
  const root = real(hostConfigRoot());
  const target = real(p);
  return target === root || target.startsWith(root + path.sep);
}

function assertRwMount(p: string, label: string): string {
  const target = real(p);
  if (isInsideSecret(target)) {
    throw new SandboxUnavailableError(`refusing to mount the host config directory (${label})`);
  }
  return target;
}

function assertRoMount(p: string): string | null {
  const target = real(p);
  if (isSecretRoot(target)) return null;
  if (!statExists(target)) return null;
  return target;
}

function assertRoFile(p: string): string {
  const target = real(p);
  if (isInsideSecret(target)) {
    throw new SandboxUnavailableError("refusing to mount the host config directory (file)");
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new SandboxUnavailableError("read-only mount is not a file");
  }
  if (!st.isFile()) throw new SandboxUnavailableError("read-only mount is not a file");
  return target;
}

function assertApprovalSocket(p: string): string {
  const target = real(p);
  if (isInsideSecret(target)) {
    throw new SandboxUnavailableError("refusing to mount the host config directory (approval socket)");
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new SandboxUnavailableError("approval socket is missing");
  }
  if (!st.isSocket()) throw new SandboxUnavailableError("approval socket is missing");
  return target;
}

/** Node binary the phone hook runs inside the jail. A copy outside the system prefixes is mounted as a file. */
export function sandboxNodeFiles(): { nodeBin: string; readOnlyFiles: string[] } {
  const bin = real(process.execPath);
  if (coveredBySystem(bin)) return { nodeBin: bin, readOnlyFiles: [] };
  return { nodeBin: bin, readOnlyFiles: [bin] };
}

function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function resolveBin(bin: string): string {
  if (bin.includes("/")) return real(bin);
  const found = spawnSync("bash", ["-c", 'command -v "$1"', "bash", bin], { encoding: "utf8" });
  const line = found.stdout.trim().split("\n").filter(Boolean).pop();
  if (found.status !== 0 || !line) {
    throw new SandboxUnavailableError(`cannot find ${bin} to run inside the sandbox`);
  }
  return real(line);
}

const SYSTEM_PREFIXES = ["/bin/", "/sbin/", "/usr/", "/lib/", "/lib64/", "/etc/", "/opt/"];

function coveredBySystem(p: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

function configDirs(env: Record<string, string>): string[] {
  const dirs: string[] = [];
  for (const key of CONFIG_DIR_KEYS) {
    const value = env[key];
    if (value && path.isAbsolute(value)) dirs.push(value);
  }
  const npmrc = env.NPM_CONFIG_USERCONFIG;
  if (npmrc && path.isAbsolute(npmrc)) dirs.push(path.dirname(npmrc));
  return dirs;
}

export function seatbeltProfile(opts: {
  cwd: string;
  extraDirs: string[];
  readOnlyDirs: string[];
  secret: string;
  approvalSocket?: string;
  readOnlyFiles?: string[];
}): string {
  const allow = (p: string, write: boolean) =>
    write
      ? `(allow file-read* file-write* (subpath ${JSON.stringify(p)}))`
      : `(allow file-read* (subpath ${JSON.stringify(p)}))`;
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow network*)",
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/System") (subpath "/Library") (subpath "/Applications") (subpath "/private/var") (subpath "/dev"))',
    '(deny file-read* file-write* (subpath "/Users"))',
    allow(opts.cwd, true),
    ...opts.extraDirs.map((d) => allow(d, true)),
    ...opts.readOnlyDirs.map((d) => allow(d, false)),
    `(deny file-read* file-write* (subpath ${JSON.stringify(opts.secret)}))`,
  ];
  if (opts.approvalSocket) {
    lines.push(
      `(allow file-read* file-write* (literal ${JSON.stringify(opts.approvalSocket)}))`,
    );
  }
  for (const file of opts.readOnlyFiles ?? []) {
    lines.push(`(allow file-read* (literal ${JSON.stringify(file)}))`);
  }
  return lines.join("\n") + "\n";
}

function assertSandboxTool(): void {
  if (process.platform === "linux") {
    const r = spawnSync("unshare", ["--version"], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new SandboxUnavailableError("unshare is not available; refusing to run this job unsandboxed");
    }
    return;
  }
  if (process.platform === "darwin") {
    if (!statExists("/usr/bin/sandbox-exec")) {
      throw new SandboxUnavailableError("sandbox-exec is not available; refusing to run this job unsandboxed");
    }
    return;
  }
  throw new SandboxUnavailableError(
    `no per-job sandbox on ${process.platform}; refusing to run this job unsandboxed`,
  );
}

const SETUP_SCRIPT = `#!/bin/bash
set -euo pipefail
root="$1"; cwd="$2"; home="$3"; ptmp="$4"; envfile="$5"; extrafile="$6"; rofile="$7"; sock="$8"; rofiles="$9"
shift 9
bind_ro() {
  local src="$1" dest="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  mount --bind "$src" "$dest"
  mount -o remount,bind,ro "$dest"
}
for d in /bin /sbin /usr /lib /lib64 /etc /opt; do
  bind_ro "$d" "$root$d"
done
mkdir -p "$root/proc" "$root/dev" "$root/tmp" "$root/home/sandbox"
mount -t proc proc "$root/proc"
for n in null zero urandom random; do
  if [ -e "/dev/$n" ]; then
    touch "$root/dev/$n"
    mount --bind "/dev/$n" "$root/dev/$n"
  fi
done
mount --bind "$home" "$root/home/sandbox"
mount --bind "$ptmp" "$root/tmp"
chmod 1777 "$root/tmp" || true
mkdir -p "$root$cwd"
mount --bind "$cwd" "$root$cwd"
if [ -f "$extrafile" ]; then
  while IFS= read -r -d '' dir || [ -n "$dir" ]; do
    [ -n "$dir" ] || continue
    mkdir -p "$root$dir"
    mount --bind "$dir" "$root$dir"
  done < "$extrafile"
fi
if [ -f "$rofile" ]; then
  while IFS= read -r -d '' dir || [ -n "$dir" ]; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    mkdir -p "$root$dir"
    mount --bind "$dir" "$root$dir"
    mount -o remount,bind,ro "$root$dir"
  done < "$rofile"
fi
if [ -n "$sock" ]; then
  [ -S "$sock" ] || { echo "approval socket missing" >&2; exit 1; }
  touch "$root${SANDBOX_APPROVAL_SOCK}"
  mount --bind "$sock" "$root${SANDBOX_APPROVAL_SOCK}"
fi
if [ -f "$rofiles" ]; then
  while IFS= read -r -d '' file || [ -n "$file" ]; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue
    dest="$root$file"
    mkdir -p "$(dirname "$dest")"
    touch "$dest"
    mount --bind "$file" "$dest"
    mount -o remount,bind,ro "$dest"
  done < "$rofiles"
fi
env_args=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8)
if [ -f "$envfile" ]; then
  while IFS= read -r -d '' line || [ -n "$line" ]; do
    case "$line" in
      ""|CLAUDE_DISPATCH_TOKEN=*|CLAUDE_DISPATCH_HOST=*|CLAUDE_DISPATCH_SESSION_ID=*|CLAUDE_DISPATCH_*|CLAUDE_APPROVAL_SOCK=*) continue ;;
      *=*) env_args+=("$line") ;;
    esac
  done < "$envfile"
fi
rm -f "$envfile"
env_args+=(HOME=/home/sandbox TMPDIR=/tmp)
exec chroot "$root" /usr/bin/env -i "\${env_args[@]}" \
  /bin/bash -c 'cd "$1" && shift && exec "$@"' bash "$cwd" "$@"
`;

function writeNulList(file: string, items: string[]): void {
  writeFileSync(file, items.length ? Buffer.from(items.join("\0") + "\0") : Buffer.alloc(0));
}

export interface SandboxSpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  extraDirs?: string[];
  env?: NodeJS.ProcessEnv;
  stdio: StdioOptions;
  /** Host path of the approval socket. Linux bind-mounts it at SANDBOX_APPROVAL_SOCK. */
  approvalSocket?: string;
  /** Regular files bind-mounted read-only at the same absolute path. Never a directory. */
  readOnlyFiles?: string[];
}

export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
  const cwd = assertRwMount(opts.cwd, "cwd");
  if (!statExists(cwd) || !statSync(cwd).isDirectory()) {
    throw new SandboxUnavailableError("cwd is not a directory");
  }
  const extraDirs = (opts.extraDirs ?? []).map((d) => assertRwMount(d, "extra dir"));
  for (const dir of extraDirs) {
    if (!statExists(dir) || !statSync(dir).isDirectory()) {
      throw new SandboxUnavailableError(`extra dir is not a directory: ${dir}`);
    }
  }
  const env = explicitChildEnv(opts.env);
  const bin = resolveBin(opts.bin);
  const roDirs = [...configDirs(env)];
  if (!coveredBySystem(bin)) {
    const binDir = path.dirname(bin);
    if (isInsideSecret(binDir)) {
      throw new SandboxUnavailableError("refusing to mount the host config directory (program)");
    }
    roDirs.push(binDir);
  }
  const readOnly = roDirs
    .map((d) => assertRoMount(d))
    .filter((d): d is string => Boolean(d));
  const readOnlyFiles = [...new Set((opts.readOnlyFiles ?? []).map((file) => assertRoFile(file)))];
  const approvalSocket = opts.approvalSocket ? assertApprovalSocket(opts.approvalSocket) : "";
  assertSandboxTool();

  if (process.platform === "darwin") {
    const work = mkdtempSync(path.join(tmpdir(), "cs-sandbox-"));
    const profilePath = path.join(work, "seatbelt.sb");
    writeFileSync(
      profilePath,
      seatbeltProfile({
        cwd,
        extraDirs,
        readOnlyDirs: readOnly,
        secret: real(hostConfigRoot()),
        approvalSocket: approvalSocket || undefined,
        readOnlyFiles,
      }),
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      HOME: path.join(work, "home"),
      TMPDIR: path.join(work, "tmp"),
      PATH: env.PATH ?? "/usr/bin:/bin",
    };
    mkdirSync(childEnv.HOME!, { recursive: true });
    mkdirSync(childEnv.TMPDIR!, { recursive: true });
    const child = spawn("sandbox-exec", ["-f", profilePath, "--", bin, ...opts.args], {
      cwd,
      env: childEnv,
      stdio: opts.stdio,
    });
    const cleanup = () => rmSync(work, { recursive: true, force: true });
    child.on("exit", cleanup);
    child.on("error", cleanup);
    return child;
  }

  const work = mkdtempSync(path.join(tmpdir(), "cs-sandbox-"));
  const root = path.join(work, "root");
  const home = path.join(work, "home");
  const ptmp = path.join(work, "tmp");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(ptmp, { recursive: true });
  const script = path.join(work, "setup.sh");
  const envFile = path.join(work, "env");
  const extraFile = path.join(work, "extra");
  const roFile = path.join(work, "ro");
  const roFilesFile = path.join(work, "rofiles");
  writeFileSync(script, SETUP_SCRIPT, { mode: 0o700 });
  const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeNulList(envFile, envLines);
  writeNulList(extraFile, extraDirs);
  writeNulList(roFile, readOnly);
  writeNulList(roFilesFile, readOnlyFiles);
  const child = spawn(
    "unshare",
    [
      ...LINUX_UNSHARE_ARGS,
      "--",
      "bash",
      script,
      root,
      cwd,
      home,
      ptmp,
      envFile,
      extraFile,
      roFile,
      approvalSocket,
      roFilesFile,
      bin,
      ...opts.args,
    ],
    { stdio: opts.stdio, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } },
  );
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  child.on("exit", cleanup);
  child.on("error", cleanup);
  return child;
}

const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 100_000;

export interface SandboxExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** One shell command inside the jail. Same result shape as the host exec path. */
export function runCommandSandboxed(req: SandboxExecRequest): Promise<SandboxExecResult> {
  const cwd = req.cwd ? path.resolve(req.cwd) : process.cwd();
  const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const start = Date.now();
  const child = spawnSandboxed({
    bin: "/bin/bash",
    args: ["-lc", req.command],
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        exitCode,
        durationMs: Date.now() - start,
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1);
    }, timeoutMs);
    child.stdout?.on("data", (buf: Buffer) => {
      stdout = (stdout + buf.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof SandboxUnavailableError ? err : new SandboxUnavailableError(err.message));
    });
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL" && settled) return;
      finish(code ?? 1);
    });
  });
}
