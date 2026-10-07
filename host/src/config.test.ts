import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { HostConfigFile } from "./types.js";

const cleanup: string[] = [];

function tmpConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-config-"));
  cleanup.push(d);
  return d;
}

afterEach(() => {
  // Vitest runs sequentially per-file; leaving tmp dirs is fine but tidy up.
  for (const d of cleanup.splice(0)) {
    try {
      // best-effort — the fresh dir was already emptied by writeFileSync
      // overwriting config.json; no rmSync needed for CI cleanliness.
      void d;
    } catch {
      /* ignore */
    }
  }
});

describe("loadConfig hostId", () => {
  it("mints a hostId when writing a fresh config", () => {
    const dir = tmpConfigDir();
    const cfgPath = join(dir, "config.json");
    const cfg = loadConfig(cfgPath);
    expect(cfg.hostId).toBeTruthy();
    expect(cfg.hostId).toMatch(/^[0-9a-f-]{36}$/i);

    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as HostConfigFile;
    expect(onDisk.hostId).toBe(cfg.hostId);
  });

  it("keeps a hostId stable across reads", () => {
    const dir = tmpConfigDir();
    const cfgPath = join(dir, "config.json");
    const first = loadConfig(cfgPath);
    const second = loadConfig(cfgPath);
    expect(second.hostId).toBe(first.hostId);
  });

  it("mints and persists a hostId onto a pre-existing config that lacks one", () => {
    const dir = tmpConfigDir();
    const cfgPath = join(dir, "config.json");
    // Simulate a config from before RFC-024: valid, but no hostId.
    const legacy = {
      hostToken: "existing-token-0123456789abcdef",
      bindHost: "0.0.0.0",
      bindPort: 8787,
      grokBinary: "/usr/local/bin/grok",
      projects: [],
      allowCustomPaths: true,
      profiles: [],
      autoApproveKinds: ["read"],
      notifyDesktop: true,
      dataDir: dir,
    };
    writeFileSync(cfgPath, JSON.stringify(legacy, null, 2) + "\n", "utf8");

    const cfg = loadConfig(cfgPath);
    expect(cfg.hostId).toBeTruthy();
    expect(cfg.hostId).toMatch(/^[0-9a-f-]{36}$/i);
    // The host token was preserved — hostId mint doesn't clobber other fields.
    expect(cfg.hostToken).toBe("existing-token-0123456789abcdef");

    // And the minted value is now on disk.
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as HostConfigFile;
    expect(onDisk.hostId).toBe(cfg.hostId);
  });

  it("preserves an existing hostId on subsequent boots", () => {
    const dir = tmpConfigDir();
    const cfgPath = join(dir, "config.json");
    const preset = {
      hostId: "preset-11111111-2222-3333-4444-555555555555",
      hostToken: "existing-token-0123456789abcdef",
      bindHost: "0.0.0.0",
      bindPort: 8787,
      grokBinary: "/usr/local/bin/grok",
      projects: [],
      allowCustomPaths: true,
      profiles: [],
      autoApproveKinds: [],
      notifyDesktop: true,
      dataDir: dir,
    };
    writeFileSync(cfgPath, JSON.stringify(preset, null, 2) + "\n", "utf8");

    const cfg = loadConfig(cfgPath);
    expect(cfg.hostId).toBe(preset.hostId);
  });

  it("treats whitespace / empty hostId as missing and remints", () => {
    const dir = tmpConfigDir();
    const cfgPath = join(dir, "config.json");
    const blank = {
      hostId: "   ",
      hostToken: "existing-token-0123456789abcdef",
      bindHost: "0.0.0.0",
      bindPort: 8787,
      grokBinary: "/usr/local/bin/grok",
      projects: [],
      allowCustomPaths: true,
      profiles: [],
      autoApproveKinds: [],
      notifyDesktop: true,
      dataDir: dir,
    };
    writeFileSync(cfgPath, JSON.stringify(blank, null, 2) + "\n", "utf8");

    const cfg = loadConfig(cfgPath);
    expect(cfg.hostId.trim()).not.toBe("");
    expect(cfg.hostId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("loadConfig repo updates (RFC-059)", () => {
  const base = (dir: string, extra: Record<string, unknown>) => ({
    hostId: "preset-11111111-2222-3333-4444-555555555555",
    hostToken: "existing-token-0123456789abcdef",
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "/usr/local/bin/grok",
    projects: [],
    allowCustomPaths: true,
    profiles: [],
    autoApproveKinds: [],
    notifyDesktop: true,
    dataDir: dir,
    ...extra,
  });

  it("trims repoDir and turns autoUpdate on only when the flag is exactly true", () => {
    const prevRepo = process.env.GROK_DISPATCH_REPO;
    const prevAuto = process.env.GROK_DISPATCH_AUTO_UPDATE;
    delete process.env.GROK_DISPATCH_REPO;
    delete process.env.GROK_DISPATCH_AUTO_UPDATE;
    try {
      const dir = tmpConfigDir();
      const on = join(dir, "on.json");
      writeFileSync(on, JSON.stringify(base(dir, { repoDir: " /tmp/cs-repo ", autoUpdate: true })) + "\n");
      const enabled = loadConfig(on);
      expect(enabled.repoDir).toBe("/tmp/cs-repo");
      expect(enabled.autoUpdate).toBe(true);

      const off = join(dir, "off.json");
      writeFileSync(off, JSON.stringify(base(dir, { repoDir: "/tmp/cs-repo", autoUpdate: "yes" })) + "\n");
      expect(loadConfig(off).autoUpdate).toBe(false);
    } finally {
      if (prevRepo === undefined) delete process.env.GROK_DISPATCH_REPO;
      else process.env.GROK_DISPATCH_REPO = prevRepo;
      if (prevAuto === undefined) delete process.env.GROK_DISPATCH_AUTO_UPDATE;
      else process.env.GROK_DISPATCH_AUTO_UPDATE = prevAuto;
    }
  });
});
