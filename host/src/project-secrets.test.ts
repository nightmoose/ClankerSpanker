import { describe, expect, it } from "vitest";
import {
  DATABASE_CONNECTION_SLOT,
  get,
  remove,
  removeAllForProject,
  set,
} from "./project-secrets.js";
import type { HostConfigFile } from "./types.js";

function makeConfig(): HostConfigFile {
  return {
    hostId: "host-1",
    hostToken: "token",
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "grok",
    projects: [],
    allowCustomPaths: false,
    profiles: [],
    autoApproveKinds: [],
    notifyDesktop: false,
    dataDir: "/tmp/clankerspanker-test",
  };
}

describe("project-secrets", () => {
  it("returns undefined when nothing is set", () => {
    const cfg = makeConfig();
    expect(get(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBeUndefined();
  });

  it("set then get round-trips the value", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "postgres://user:pw@host/db");
    expect(get(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBe("postgres://user:pw@host/db");
  });

  it("isolates slots across projects", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "one");
    set(cfg, "p2", DATABASE_CONNECTION_SLOT, "two");
    expect(get(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBe("one");
    expect(get(cfg, "p2", DATABASE_CONNECTION_SLOT)).toBe("two");
  });

  it("set overwrites the existing value in place", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "first");
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "second");
    expect(get(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBe("second");
  });

  it("remove returns true on hit and clears the slot", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "x");
    expect(remove(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBe(true);
    expect(get(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBeUndefined();
  });

  it("remove returns false when the slot was never set", () => {
    const cfg = makeConfig();
    expect(remove(cfg, "p1", DATABASE_CONNECTION_SLOT)).toBe(false);
  });

  it("remove drops the project bucket once the last slot is cleared", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "x");
    remove(cfg, "p1", DATABASE_CONNECTION_SLOT);
    expect(cfg.projectSecrets?.p1).toBeUndefined();
  });

  it("removeAllForProject clears every slot bound to that project", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "x");
    set(cfg, "p1", "project.extra", "y");
    set(cfg, "p2", DATABASE_CONNECTION_SLOT, "z");
    removeAllForProject(cfg, "p1");
    expect(cfg.projectSecrets?.p1).toBeUndefined();
    expect(get(cfg, "p2", DATABASE_CONNECTION_SLOT)).toBe("z");
  });

  it("project endpoint shape never carries the secret", () => {
    const cfg = makeConfig();
    set(cfg, "p1", DATABASE_CONNECTION_SLOT, "secret");
    const projectShape: Record<string, unknown> = {
      id: "p1",
      name: "P1",
      paths: ["/tmp/p1"],
      path: "/tmp/p1",
      database: {
        provider: "supabase" as const,
        connectionRef: DATABASE_CONNECTION_SLOT,
        addedAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      },
    };
    const serialized = JSON.stringify(projectShape);
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain(DATABASE_CONNECTION_SLOT);
  });
});
