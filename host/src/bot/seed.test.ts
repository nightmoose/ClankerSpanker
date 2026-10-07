import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProject } from "../config.js";
import type { HostConfigFile } from "../types.js";
import { HUNTER_BOT_ID, seedHunter } from "./seed.js";
import { BotStore } from "./store.js";

function config(dir: string): HostConfigFile {
  return {
    hostToken: "t",
    bindHost: "127.0.0.1",
    bindPort: 0,
    grokBinary: "grok",
    projects: [],
    allowCustomPaths: true,
    profiles: [{ id: "nightmoose", name: "NightMoose", backend: "grok", color: "#22C55E" }],
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir: dir,
  };
}

function scratch(): { dataDir: string; configPath: string; checkout: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-seed-"));
  return {
    dataDir,
    configPath: join(dataDir, "config.json"),
    checkout: join(dataDir, "contractgate"),
  };
}

describe("seedHunter", () => {
  it("does not advertise a hunter when this host has no ContractGate checkout", () => {
    const { dataDir, configPath, checkout } = scratch();
    const cfg = config(dataDir);
    const store = new BotStore(dataDir);
    store.create({
      id: HUNTER_BOT_ID,
      name: "ContractGate Hunter",
      enabled: false,
      profileId: "nightmoose",
      projectId: "contractgate",
      job: "old",
      interval: "6h",
    });
    store.create({
      id: "other-bot",
      name: "Other",
      enabled: false,
      profileId: "nightmoose",
      projectId: "somewhere",
      job: "keep me",
      interval: "1d",
    });

    seedHunter(cfg, store, { contractgateDir: checkout, configPath });

    expect(store.get(HUNTER_BOT_ID)).toBeNull();
    expect(store.get("other-bot")?.job).toBe("keep me");
    expect(cfg.projects).toEqual([]);
  });

  it("creates the project and a paused hunter when the checkout is unregistered", () => {
    const { dataDir, configPath, checkout } = scratch();
    mkdirSync(checkout);
    const cfg = config(dataDir);
    const store = new BotStore(dataDir);

    seedHunter(cfg, store, { contractgateDir: checkout, configPath });

    expect(cfg.projects.map((p) => p.id)).toEqual(["contractgate"]);
    expect(cfg.projects[0]?.path).toBe(checkout);
    const hunter = store.get(HUNTER_BOT_ID);
    expect(hunter?.projectId).toBe("contractgate");
    expect(hunter?.enabled).toBe(false);
    expect(hunter?.profileId).toBe("nightmoose");
  });

  it("binds the hunter to whichever project already covers the checkout", () => {
    const { dataDir, configPath, checkout } = scratch();
    mkdirSync(checkout);
    const elsewhere = join(dataDir, "elsewhere");
    mkdirSync(elsewhere);
    const cfg = config(dataDir);
    cfg.projects = [
      normalizeProject({
        id: "work",
        name: "Work",
        path: elsewhere,
        paths: [elsewhere, checkout],
      }),
    ];
    const store = new BotStore(dataDir);
    store.create({
      id: HUNTER_BOT_ID,
      name: "ContractGate Hunter",
      enabled: false,
      profileId: "nightmoose",
      projectId: "contractgate",
      job: "You are ContractGate Hunter. Do not conclude there is no market because a search tool returned nothing.",
      interval: "6h",
    });

    seedHunter(cfg, store, { contractgateDir: checkout, configPath });

    expect(cfg.projects.map((p) => p.id)).toEqual(["work"]);
    expect(store.get(HUNTER_BOT_ID)?.projectId).toBe("work");
    expect(store.get(HUNTER_BOT_ID)?.enabled).toBe(false);
  });

  it("points a dead contractgate project at the checkout instead of 400ing", () => {
    const { dataDir, configPath, checkout } = scratch();
    mkdirSync(checkout);
    const cfg = config(dataDir);
    cfg.projects = [
      normalizeProject({
        id: "contractgate",
        name: "ContractGate",
        path: join(dataDir, "missing-checkout"),
      }),
    ];
    const store = new BotStore(dataDir);
    writeFileSync(configPath, "{}\n");

    seedHunter(cfg, store, { contractgateDir: checkout, configPath });

    expect(cfg.projects).toHaveLength(1);
    expect(cfg.projects[0]?.path).toBe(checkout);
    expect(store.get(HUNTER_BOT_ID)?.projectId).toBe("contractgate");
  });
});
