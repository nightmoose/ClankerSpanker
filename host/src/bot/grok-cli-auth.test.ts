import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGrokCliAccessToken,
  grokAuthJsonPathsForProfile,
  readGrokCliAccessToken,
  readGrokCliCreds,
  refreshGrokCliCreds,
} from "./grok-cli-auth.js";

function writeAuth(dir: string, entry: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "auth.json");
  writeFileSync(
    file,
    JSON.stringify({
      "https://auth.x.ai::client": entry,
    }),
  );
  return file;
}

describe("grokAuthJsonPathsForProfile", () => {
  it("prefers isolated grok-homes then ~/.grok", () => {
    const paths = grokAuthJsonPathsForProfile({ id: "nightmoose" }, "/data");
    expect(paths[0]).toBe(join("/data", "grok-homes", "nightmoose", "auth.json"));
    expect(paths).toContain(join(homedir(), ".grok", "auth.json"));
  });
});

describe("readGrokCliCreds newest expiry", () => {
  it("picks the unexpired copy when ~/.grok is stale", () => {
    const staleDir = mkdtempSync(join(tmpdir(), "grok-stale-"));
    const freshDir = mkdtempSync(join(tmpdir(), "grok-fresh-"));
    const stale = writeAuth(staleDir, {
      key: "old",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    const fresh = writeAuth(freshDir, {
      key: "new",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const creds = readGrokCliCreds([stale, fresh]);
    expect(creds?.accessToken).toBe("new");
  });
});

describe("readGrokCliAccessToken", () => {
  it("reads key from grok CLI auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    const file = writeAuth(dir, { key: "jwt-from-cli", email: "a@b.c" });
    expect(readGrokCliAccessToken([file])).toBe("jwt-from-cli");
  });

  it("returns null when missing", () => {
    expect(readGrokCliAccessToken([join(tmpdir(), "nope-auth.json")])).toBeNull();
  });
});

describe("getGrokCliAccessToken refresh", () => {
  it("refreshes when expires_at is in the past and writes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    const file = writeAuth(dir, {
      key: "stale-jwt",
      refresh_token: "rt-1",
      oidc_client_id: "client-1",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    const token = await getGrokCliAccessToken([file], async (input, init) => {
      expect(String(input)).toContain("auth.x.ai/oauth2/token");
      const body = String(init?.body);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=rt-1");
      expect(body).toContain("client_id=client-1");
      return new Response(
        JSON.stringify({
          access_token: "fresh-jwt",
          refresh_token: "rt-2",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    expect(token).toBe("fresh-jwt");
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      "https://auth.x.ai::client": { key: string; refresh_token: string };
    };
    expect(saved["https://auth.x.ai::client"].key).toBe("fresh-jwt");
    expect(saved["https://auth.x.ai::client"].refresh_token).toBe("rt-2");
  });

  it("does not refresh a still-valid token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const file = writeAuth(dir, {
      key: "still-good",
      refresh_token: "rt",
      oidc_client_id: "client-1",
      expires_at: future,
    });
    let called = 0;
    const token = await getGrokCliAccessToken([file], async () => {
      called += 1;
      return new Response("nope", { status: 500 });
    });
    expect(token).toBe("still-good");
    expect(called).toBe(0);
  });

  it("keeps the stale token if refresh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-auth-"));
    const file = writeAuth(dir, {
      key: "stale-jwt",
      refresh_token: "rt",
      oidc_client_id: "client-1",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    const creds = readGrokCliCreds([file])!;
    const next = await refreshGrokCliCreds(creds, async () => new Response("no", { status: 400 }));
    expect(next).toBeNull();
    expect(readGrokCliAccessToken([file])).toBe("stale-jwt");
  });
});
