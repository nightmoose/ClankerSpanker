import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "./config.js";
import { isTailscaleAddr } from "./platform.js";
import { connectPayload } from "./server.js";
import type { HostConfigFile } from "./types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-perms-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

describe("config.json permissions (RFC-026)", () => {
  it("writes a fresh config owner-only", () => {
    const p = join(tmp(), "config.json");
    loadConfig(p);
    expect(mode(p)).toBe(0o600);
  });

  it("saveConfig keeps the file owner-only", () => {
    const p = join(tmp(), "config.json");
    const cfg = loadConfig(p);
    chmodSync(p, 0o644);
    saveConfig(cfg, p);
    expect(mode(p)).toBe(0o600);
  });

  it("loadConfig tightens a world-readable config and its .bak siblings", () => {
    const d = tmp();
    const p = join(d, "config.json");
    loadConfig(p);
    const bak = join(d, "config.json.bak-20260807-134342");
    writeFileSync(bak, "{}", "utf8");
    chmodSync(p, 0o644);
    chmodSync(bak, 0o644);
    const other = join(d, "bots.json");
    writeFileSync(other, "{}", "utf8");
    chmodSync(other, 0o644);

    loadConfig(p);
    expect(mode(p)).toBe(0o600);
    expect(mode(bak)).toBe(0o600);
    expect(mode(other)).toBe(0o644); // only config.json + its backups
  });
});

describe("host token persistence (RFC-026)", () => {
  it("mints and persists a token when it was deleted (rotation)", () => {
    const p = join(tmp(), "config.json");
    const first = loadConfig(p);
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<HostConfigFile>;
    delete raw.hostToken;
    writeFileSync(p, JSON.stringify(raw), "utf8");

    const rotated = loadConfig(p);
    expect(rotated.hostToken).toMatch(/^[0-9a-f]{48}$/);
    expect(rotated.hostToken).not.toBe(first.hostToken);
    expect(loadConfig(p).hostToken).toBe(rotated.hostToken); // stable across restarts
  });

  it("keeps an explicitly empty token empty (authorises nobody)", () => {
    const p = join(tmp(), "config.json");
    loadConfig(p);
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<HostConfigFile>;
    raw.hostToken = "";
    writeFileSync(p, JSON.stringify(raw), "utf8");
    expect(loadConfig(p).hostToken).toBe("");
  });
});

describe("connectPayload (RFC-026)", () => {
  it("omits projects and names the host in the deep link", () => {
    const p = join(tmp(), "config.json");
    const cfg = loadConfig(p);
    const payload = connectPayload(cfg, { headers: { host: "100.66.33.89:8787" } }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("projects");
    expect(String(payload.deepLink)).toMatch(/^clankerspanker:\/\/configure\?url=http%3A%2F%2F100\.66\.33\.89%3A8787&token=[0-9a-f]+&name=.+/);
  });
});

describe("isTailscaleAddr", () => {
  it("matches only 100.64.0.0/10", () => {
    expect(isTailscaleAddr("100.66.33.89")).toBe(true);
    expect(isTailscaleAddr("100.127.0.1")).toBe(true);
    expect(isTailscaleAddr("100.63.0.1")).toBe(false);
    expect(isTailscaleAddr("100.128.0.1")).toBe(false);
    expect(isTailscaleAddr("192.168.1.220")).toBe(false);
  });
});
