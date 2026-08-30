import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizationServerMetadataUrls,
  b64url,
  bearerHeaderIfFresh,
  canonicalResource,
  completeMcpOAuth,
  generatePkce,
  logoutMcpOAuth,
  mcpOAuthRedirectUri,
  oauthHeaderMap,
  oauthStatus,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
  refreshIfNeeded,
  resetMcpOAuthPending,
  startMcpOAuth,
  writeOAuthTokens,
} from "./mcp-oauth.js";
import { toAcpMcpServers, toMcpJson } from "./mcp.js";

afterEach(() => {
  resetMcpOAuthPending();
});

function mockFetch(
  routes: Record<
    string,
    | { status: number; json?: unknown; headers?: Record<string, string> }
    | ((url: string, init?: RequestInit) => { status: number; json?: unknown; headers?: Record<string, string> })
  >,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = routes[`${method} ${url}`] ?? routes[url];
    if (!hit) throw new Error(`unexpected fetch ${method} ${url}`);
    const res = typeof hit === "function" ? hit(url, init) : hit;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: new Headers(res.headers ?? {}),
      json: async () => res.json ?? {},
      text: async () => JSON.stringify(res.json ?? {}),
    } as Response;
  }) as typeof fetch;
}

describe("pkce + discovery helpers", () => {
  it("S256 challenge is base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce(() => Buffer.from("a".repeat(32)));
    expect(verifier).toBe(b64url(Buffer.from("a".repeat(32))));
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("builds RFC 9728 and RFC 8414 well-known URLs", () => {
    expect(protectedResourceMetadataUrls("https://mcp.example.com/v1/mcp")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
    expect(canonicalResource("https://mcp.example.com/mcp/")).toBe("https://mcp.example.com/mcp");
  });

  it("parses WWW-Authenticate resource_metadata and scope", () => {
    expect(
      parseWwwAuthenticate(
        `Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"`,
      ),
    ).toEqual({
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "files:read",
    });
  });

  it("redirect URI is loopback on the host bind port", () => {
    expect(mcpOAuthRedirectUri(8787)).toBe("http://127.0.0.1:8787/mcp/oauth/callback");
  });
});

describe("start + exchange + logout", () => {
  it("start builds an authorize URL with PKCE, resource, state; callback stores tokens; logout deletes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-oauth-"));
    const fetchImpl = mockFetch({
      "GET https://mcp.example.com/mcp": {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        },
      },
      "GET https://mcp.example.com/.well-known/oauth-protected-resource": {
        status: 200,
        json: {
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["mcp"],
        },
      },
      "GET https://auth.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        json: {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
        },
      },
      "POST https://auth.example.com/register": {
        status: 201,
        json: { client_id: "dyn-client", token_endpoint_auth_method: "none" },
      },
      "POST https://auth.example.com/token": (_url, init) => {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=abc");
        expect(body).toContain("code_verifier=");
        expect(body).toContain("resource=");
        return {
          status: 200,
          json: {
            access_token: "atk-1",
            refresh_token: "rtk-1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mcp",
          },
        };
      },
    });

    const started = await startMcpOAuth({
      dataDir: dir,
      profileId: "nightmoose",
      serverName: "gmail",
      mcpUrl: "https://mcp.example.com/mcp",
      redirectUri: "http://127.0.0.1:8787/mcp/oauth/callback",
      deps: { fetch: fetchImpl, now: () => 1_700_000_000_000 },
    });
    const auth = new URL(started.authorizeUrl);
    expect(auth.origin + auth.pathname).toBe("https://auth.example.com/authorize");
    expect(auth.searchParams.get("response_type")).toBe("code");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(auth.searchParams.get("state")).toBe(started.state);
    expect(auth.searchParams.get("client_id")).toBe("dyn-client");
    expect(auth.searchParams.get("scope")).toBe("mcp");

    const done = await completeMcpOAuth({
      dataDir: dir,
      state: started.state,
      code: "abc",
      deps: { fetch: fetchImpl, now: () => 1_700_000_000_000 },
    });
    expect(done).toEqual({ profileId: "nightmoose", serverName: "gmail" });
    expect(oauthStatus(dir, "nightmoose", "gmail", () => 1_700_000_000_000).connected).toBe(true);
    const stored = JSON.parse(
      readFileSync(join(dir, "mcp-oauth", "nightmoose", "gmail.json"), "utf8"),
    ) as { accessToken: string };
    expect(stored.accessToken).toBe("atk-1");

    expect(logoutMcpOAuth(dir, "nightmoose", "gmail")).toBe(true);
    expect(oauthStatus(dir, "nightmoose", "gmail").connected).toBe(false);
  });

  it("requires oauthClientId when DCR is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-oauth-"));
    const fetchImpl = mockFetch({
      "GET https://mcp.example.com/mcp": { status: 401 },
      "GET https://mcp.example.com/.well-known/oauth-protected-resource": {
        status: 200,
        json: { authorization_servers: ["https://auth.example.com"] },
      },
      "GET https://auth.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        json: {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        },
      },
    });
    await expect(
      startMcpOAuth({
        dataDir: dir,
        profileId: "nightmoose",
        serverName: "gmail",
        mcpUrl: "https://mcp.example.com/mcp",
        redirectUri: "http://127.0.0.1:8787/mcp/oauth/callback",
        deps: { fetch: fetchImpl },
      }),
    ).rejects.toThrow(/oauthClientId/);
  });
});

describe("refresh + header injection", () => {
  it("refreshes an expired token and rotates the refresh token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-oauth-"));
    writeOAuthTokens(dir, "nightmoose", "gmail", {
      accessToken: "old",
      refreshToken: "rt-old",
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      expiresAt: 1_000,
      obtainedAt: 1,
    });
    const fetchImpl = mockFetch({
      "POST https://auth.example.com/token": (_url, init) => {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=refresh_token");
        expect(body).toContain("refresh_token=rt-old");
        return {
          status: 200,
          json: { access_token: "new", refresh_token: "rt-new", expires_in: 3600 },
        };
      },
    });
    const next = await refreshIfNeeded(dir, "nightmoose", "gmail", {
      fetch: fetchImpl,
      now: () => 50_000,
    });
    expect(next?.accessToken).toBe("new");
    expect(next?.refreshToken).toBe("rt-new");
  });

  it("omits expired tokens from header maps", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-oauth-"));
    writeOAuthTokens(dir, "nightmoose", "gmail", {
      accessToken: "stale",
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      expiresAt: 10,
      obtainedAt: 1,
    });
    expect(bearerHeaderIfFresh(dir, "nightmoose", "gmail", () => 100_000)).toBeUndefined();
    writeOAuthTokens(dir, "nightmoose", "gmail", {
      accessToken: "live",
      clientId: "cid",
      tokenEndpoint: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      expiresAt: 200_000,
      obtainedAt: 1,
    });
    expect(bearerHeaderIfFresh(dir, "nightmoose", "gmail", () => 100_000)).toEqual({
      Authorization: "Bearer live",
    });
  });

  it("toMcpJson injects Bearer and does not overwrite an existing Authorization header", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-oauth-"));
    writeOAuthTokens(dir, "p", "gmail", {
      accessToken: "tok",
      clientId: "c",
      tokenEndpoint: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      obtainedAt: 1,
    });
    const oauth = oauthHeaderMap(dir, "p", [
      { name: "gmail", url: "https://mcp.example.com/mcp" },
      { name: "linear", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer static" } },
    ]);
    const json = toMcpJson(
      [
        { name: "gmail", url: "https://mcp.example.com/mcp", transport: "http" },
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer static" },
          transport: "http",
        },
      ],
      {},
      oauth,
    );
    expect(json.mcpServers.gmail).toEqual({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer tok" },
      transport: "http",
    });
    expect(json.mcpServers.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer static" },
      transport: "http",
    });
  });

  it("toAcpMcpServers injects the same Bearer pair", () => {
    const acp = toAcpMcpServers(
      [{ name: "api", url: "https://mcp.example.com/mcp" }],
      {},
      { api: { Authorization: "Bearer tok" } },
    );
    expect(acp).toEqual([
      {
        type: "http",
        name: "api",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
  });
});
