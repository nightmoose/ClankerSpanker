import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyGrokHomeToEnv,
  ensureIsolatedGrokHome,
  grokIsolationConfigToml,
  isolatedGrokHomePath,
  resolveGrokHomeForProfile,
  sharedGrokAuthPath,
} from "./grok-home.js";
import type { AgentProfile } from "./types.js";

const grokProfile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "nightmoose",
  name: "NightMoose",
  backend: "grok",
  color: "#73B8FF",
  ...over,
});

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("isolated Grok home", () => {
  it("nests under dataDir/grok-homes/{profileId}", () => {
    expect(isolatedGrokHomePath("/tmp/data", "nightmoose")).toBe(
      join("/tmp/data", "grok-homes", "nightmoose"),
    );
  });

  it("writes isolation config and auth symlink without clobbering an existing config", () => {
    const home = tmp("cs-grok-home-");
    const sharedDir = tmp("cs-shared-grok-");
    const sharedAuth = join(sharedDir, "auth.json");
    writeFileSync(sharedAuth, '{"ok":true}\n');
    ensureIsolatedGrokHome(home, { sharedAuthPath: sharedAuth });
    const cfg = readFileSync(join(home, "config.toml"), "utf8");
    expect(cfg).toContain("mcps = false");
    expect(cfg).toContain('"vercel"');
    expect(existsSync(join(home, "auth.json"))).toBe(true);
    if (lstatSync(join(home, "auth.json")).isSymbolicLink()) {
      expect(readlinkSync(join(home, "auth.json"))).toBe(sharedAuth);
    }

    writeFileSync(join(home, "config.toml"), "# operator\n");
    ensureIsolatedGrokHome(home, { sharedAuthPath: sharedAuth });
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("# operator\n");
  });

  it("resolveGrokHomeForProfile prefers explicit grokHome", () => {
    const p = grokProfile({ grokHome: "/tmp/custom-grok" });
    expect(resolveGrokHomeForProfile(p, "/data")).toBe("/tmp/custom-grok");
  });

  it("resolveGrokHomeForProfile uses dataDir when grokHome is unset", () => {
    expect(resolveGrokHomeForProfile(grokProfile(), "/data")).toBe(
      join("/data", "grok-homes", "nightmoose"),
    );
    expect(resolveGrokHomeForProfile(grokProfile(), undefined)).toBeUndefined();
    expect(
      resolveGrokHomeForProfile({ ...grokProfile(), backend: "claude" }, "/data"),
    ).toBeUndefined();
  });

  it("applyGrokHomeToEnv seeds the isolated home and sets kill switches", () => {
    const dataDir = tmp("cs-data-");
    mkdirSync(join(dataDir, "grok-homes"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    applyGrokHomeToEnv(env, grokProfile(), dataDir);
    const home = join(dataDir, "grok-homes", "nightmoose");
    expect(env.GROK_HOME).toBe(home);
    expect(env.GROK_CLAUDE_MCPS_ENABLED).toBe("false");
    expect(env.GROK_CURSOR_MCPS_ENABLED).toBe("false");
    expect(existsSync(join(home, "config.toml"))).toBe(true);
  });

  it("applyGrokHomeToEnv does not write isolation config into an explicit grokHome", () => {
    const home = tmp("cs-explicit-grok-");
    const env: NodeJS.ProcessEnv = {};
    applyGrokHomeToEnv(env, grokProfile({ grokHome: home }), "/data");
    expect(env.GROK_HOME).toBe(home);
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  it("sharedGrokAuthPath is ~/.grok/auth.json even when GROK_HOME is set", () => {
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = "/tmp/not-the-machine-login";
    try {
      expect(sharedGrokAuthPath()).toBe(join(homedir(), ".grok", "auth.json"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});

describe("grokIsolationConfigToml", () => {
  it("disables Claude/Cursor MCP and the Vercel plugin", () => {
    const toml = grokIsolationConfigToml();
    expect(toml).toMatch(/\[compat\.claude\][\s\S]*mcps = false/);
    expect(toml).toMatch(/\[compat\.cursor\][\s\S]*mcps = false/);
    expect(toml).toContain('"vercel"');
  });
});
