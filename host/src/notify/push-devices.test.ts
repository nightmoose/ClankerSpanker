import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dropPushTokens,
  loadPushDevices,
  registerPushDevice,
  unregisterPushDevice,
} from "./push-devices.js";

const TOKEN = "a".repeat(64);

function dir(): string {
  return mkdtempSync(join(tmpdir(), "cs-push-"));
}

describe("push-devices", () => {
  it("upserts by token and keeps clientHostId", () => {
    const dataDir = dir();
    registerPushDevice(dataDir, { token: TOKEN, clientHostId: "host-1", name: "Deez Nutz" });
    registerPushDevice(dataDir, { token: TOKEN.toUpperCase(), clientHostId: "host-1", name: "Deez Nutz" });
    const list = loadPushDevices(dataDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ token: TOKEN, clientHostId: "host-1", name: "Deez Nutz" });
  });

  it("rejects a non-hex token", () => {
    expect(() => registerPushDevice(dir(), { token: "not-a-token", clientHostId: "h" })).toThrow(
      /Invalid APNs device token/,
    );
  });

  it("requires clientHostId", () => {
    expect(() => registerPushDevice(dir(), { token: TOKEN, clientHostId: "  " })).toThrow(/clientHostId/);
  });

  it("unregisters and drops invalid tokens", () => {
    const dataDir = dir();
    const other = "b".repeat(64);
    registerPushDevice(dataDir, { token: TOKEN, clientHostId: "h1" });
    registerPushDevice(dataDir, { token: other, clientHostId: "h2" });
    expect(unregisterPushDevice(dataDir, TOKEN)).toBe(true);
    expect(loadPushDevices(dataDir)).toHaveLength(1);
    expect(dropPushTokens(dataDir, [other])).toBe(1);
    expect(loadPushDevices(dataDir)).toHaveLength(0);
  });

  it("caps at 20 devices (newest first)", () => {
    const dataDir = dir();
    for (let i = 0; i < 22; i++) {
      const token = i.toString(16).padStart(64, "0");
      registerPushDevice(dataDir, { token, clientHostId: "h" });
    }
    const list = loadPushDevices(dataDir);
    expect(list).toHaveLength(20);
    expect(list[0]!.token.endsWith("15")).toBe(true); // 21st insert (i=21) is hex 15
  });
});
