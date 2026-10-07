import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appInstallRoot,
  classifyUpdate,
  hostIsBusy,
  inspectUpdate,
  resolveRepoDir,
  startUpdateController,
  updateScript,
} from "./self-update.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

function pair(): { remote: string; local: string } {
  const parent = mkdtempSync(join(tmpdir(), "cs-upd-"));
  const remote = join(parent, "remote");
  const local = join(parent, "local");
  mkdirSync(join(remote, "host"), { recursive: true });
  writeFileSync(join(remote, "host", "package.json"), "{}\n");
  writeFileSync(join(remote, "README"), "a\n");
  git(remote, ["init", "-b", "main"]);
  git(remote, ["add", "."]);
  git(remote, ["commit", "-m", "init"]);
  git(parent, ["clone", remote, local]);
  return { remote, local };
}

describe("classifyUpdate", () => {
  it("refuses a dirty tree even when behind", () => {
    const s = classifyUpdate({
      repoDir: "/repo",
      branch: "main",
      upstream: "origin/main",
      dirty: true,
      behind: 3,
    });
    expect(s.state).toBe("dirty");
    expect(s.canApply).toBe(false);
  });

  it("allows a clean fast-forward", () => {
    const s = classifyUpdate({
      repoDir: "/repo",
      branch: "main",
      upstream: "origin/main",
      behind: 2,
    });
    expect(s.state).toBe("behind");
    expect(s.canApply).toBe(true);
  });

  it("does not fast-forward a diverged branch", () => {
    const s = classifyUpdate({
      repoDir: "/repo",
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
    });
    expect(s.state).toBe("diverged");
    expect(s.canApply).toBe(false);
  });
});

describe("resolveRepoDir", () => {
  it("uses a configured checkout and does not fall through", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-repo-"));
    mkdirSync(join(root, "host"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: x\n");
    writeFileSync(join(root, "host", "package.json"), "{}\n");
    const other = mkdtempSync(join(tmpdir(), "cs-other-"));
    expect(resolveRepoDir({ configured: root, env: other }).dir).toBe(root);
  });

  it("reports a bad configured path instead of guessing", () => {
    const found = resolveRepoDir({ configured: "/no/such/checkout", exists: () => false });
    expect(found.dir).toBeNull();
    expect(found.error).toMatch(/not a ClankerSpanker checkout/);
  });

  it("walks up from the running file", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-walk-"));
    mkdirSync(join(root, "host", "dist"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: x\n");
    writeFileSync(join(root, "host", "package.json"), "{}\n");
    const found = resolveRepoDir({
      argv1: join(root, "host", "dist", "index.js"),
      home: join(root, "no-home"),
    });
    expect(found.dir).toBe(root);
  });
});

describe("appInstallRoot", () => {
  it("points at the Application Support copy, not the checkout", () => {
    const argv = "/Users/a/Library/Application Support/ClankerSpanker/host/dist/index.js";
    expect(appInstallRoot(argv)).toBe("/Users/a/Library/Application Support/ClankerSpanker/host");
    expect(appInstallRoot("/Users/a/Projects/GrokDispatch/host/dist/index.js")).toBeNull();
  });
});

describe("inspectUpdate", () => {
  it("sees commits on origin that have not been pulled", async () => {
    const { remote, local } = pair();
    writeFileSync(join(remote, "README"), "b\n");
    git(remote, ["add", "README"]);
    git(remote, ["commit", "-m", "more"]);
    const status = await inspectUpdate({ repoDir: local, fetch: true });
    expect(status.state).toBe("behind");
    expect(status.behind).toBe(1);
    expect(status.canApply).toBe(true);
    expect(status.upstream).toBe("origin/main");
  });

  it("does not offer to apply over a local edit", async () => {
    const { local } = pair();
    writeFileSync(join(local, "README"), "dirty\n");
    const status = await inspectUpdate({ repoDir: local, fetch: false });
    expect(status.state).toBe("dirty");
    expect(status.canApply).toBe(false);
  });
});

describe("update script", () => {
  it("fast-forwards and never resets", () => {
    const script = updateScript();
    expect(script).toContain("git pull --ff-only");
    expect(script).not.toContain("reset --hard");
    expect(script).not.toContain("clean -fd");
    expect(script.indexOf('mkdir "$LOCK.d"')).toBeLessThan(script.indexOf("sleep 1"));
    expect(script).toContain("/opt/homebrew/bin");
  });
});

describe("startUpdateController", () => {
  it("spawns the updater only when the checkout can fast-forward", async () => {
    const { remote, local } = pair();
    writeFileSync(join(remote, "README"), "b\n");
    git(remote, ["add", "README"]);
    git(remote, ["commit", "-m", "more"]);
    const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
    const calls: string[] = [];
    const ctl = startUpdateController({
      repoDir: local,
      dataDir,
      argv1: join(local, "host", "dist", "index.js"),
      intervalMs: 60 * 60_000,
      bootDelayMs: 0,
      spawnImpl: (script) => {
        calls.push(script);
      },
    });
    const started = await ctl.apply();
    expect(started.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(started.busy).toBe(false);

    // The detached script is not still running, so a failed build can be tried again.
    const retried = await ctl.apply();
    expect(retried.ok).toBe(true);
    expect(calls).toHaveLength(2);

    writeFileSync(join(local, "README"), "dirty\n");
    const refused = await ctl.apply();
    expect(refused.ok).toBe(false);
    expect(refused.status.state).toBe("dirty");
    expect(calls).toHaveLength(2);
    ctl.stop();
  });

  it("does not start a second build while one is still running", async () => {
    const { remote, local } = pair();
    writeFileSync(join(remote, "README"), "b\n");
    git(remote, ["add", "README"]);
    git(remote, ["commit", "-m", "more"]);
    const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
    const calls: string[] = [];
    let running = false;
    const ctl = startUpdateController({
      repoDir: local,
      dataDir,
      argv1: join(local, "host", "dist", "index.js"),
      intervalMs: 60 * 60_000,
      bootDelayMs: 0,
      updaterAlive: () => running,
      spawnImpl: (script) => {
        calls.push(script);
        running = true;
      },
    });
    const started = await ctl.apply();
    expect(started.ok).toBe(true);
    const blocked = await ctl.apply();
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/already running/);
    expect(calls).toHaveLength(1);
    ctl.stop();
  });
});

describe("host-only update button", () => {
  it("is on the pages the host itself serves, not only the native app", () => {
    const root = join(__dirname, "..", "..");
    const app = readFileSync(join(root, "host", "web", "app.js"), "utf8");
    const setup = readFileSync(join(root, "host", "src", "server.ts"), "utf8");
    expect(app).toContain("Update from repo");
    expect(app).toContain('api("/host/update"');
    expect(setup).toContain("Update this host");
    expect(setup).toContain("fetch('/host/update?fetch=1'");
  });
});

describe("hostIsBusy", () => {
  it("treats an open turn as busy and an idle one as free", () => {
    expect(hostIsBusy(["idle", "failed"])).toBe(false);
    expect(hostIsBusy(["running"])).toBe(true);
    expect(hostIsBusy(["awaiting_approval"])).toBe(true);
  });
});
