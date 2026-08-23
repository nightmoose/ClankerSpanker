import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotScheduler } from "./scheduler.js";
import { BotStore, parseIntervalMs } from "./store.js";
import type { Bot, DispatchSession, HostConfigFile } from "../types.js";

function emptyConfig(): HostConfigFile {
  return {
    hostToken: "t",
    bindHost: "127.0.0.1",
    bindPort: 0,
    grokBinary: "grok",
    projects: [],
    allowCustomPaths: true,
    profiles: [],
    autoApproveKinds: ["read"],
    notifyDesktop: false,
    dataDir: mkdtempSync(join(tmpdir(), "cs-bot-data-")),
  };
}

function bot(over: Partial<Bot> = {}): Bot {
  return {
    id: "hunter",
    name: "Hunter",
    enabled: true,
    profileId: "nightmoose-bot",
    projectId: "contractgate",
    job: "hunt",
    interval: "6h",
    tools: [],
    maxTurnsPerRun: 20,
    ...over,
  };
}

describe("parseIntervalMs", () => {
  it("parses s/m/h/d", () => {
    expect(parseIntervalMs("30s")).toBe(30_000);
    expect(parseIntervalMs("1h")).toBe(3_600_000);
    expect(parseIntervalMs("6h")).toBe(6 * 3_600_000);
    expect(parseIntervalMs("1d")).toBe(86_400_000);
    expect(parseIntervalMs("nope")).toBe(0);
  });
});

describe("BotScheduler", () => {
  it("does not overlap runs", async () => {
    const store = new BotStore(emptyConfig().dataDir);
    store.create(bot({ lastRunAt: undefined }));
    let fires = 0;
    let active = false;
    const scheduler = new BotScheduler(
      store,
      {
        async fireBot() {
          fires += 1;
          active = true;
          return { id: "sess-1", status: "running" } as DispatchSession;
        },
        hasActiveRun: () => active,
      },
      emptyConfig(),
    );

    const first = await scheduler.tick(Date.now());
    expect(first).toEqual(["hunter"]);
    expect(fires).toBe(1);

    const second = await scheduler.tick(Date.now());
    expect(second).toEqual([]);
    expect(fires).toBe(1);
  });

  it("skips disabled bots", async () => {
    const store = new BotStore(emptyConfig().dataDir);
    store.create(bot({ enabled: false }));
    let fires = 0;
    const scheduler = new BotScheduler(
      store,
      {
        async fireBot() {
          fires += 1;
          return { id: "s" } as DispatchSession;
        },
        hasActiveRun: () => false,
      },
      emptyConfig(),
    );
    expect(await scheduler.tick()).toEqual([]);
    expect(fires).toBe(0);
  });

  it("skips when lastRunAt is within the interval", async () => {
    const store = new BotStore(emptyConfig().dataDir);
    store.create(bot({ lastRunAt: new Date().toISOString(), interval: "6h" }));
    let fires = 0;
    const scheduler = new BotScheduler(
      store,
      {
        async fireBot() {
          fires += 1;
          return { id: "s" } as DispatchSession;
        },
        hasActiveRun: () => false,
      },
      emptyConfig(),
    );
    expect(await scheduler.tick()).toEqual([]);
    expect(fires).toBe(0);
  });
});
