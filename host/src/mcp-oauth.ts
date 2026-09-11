import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProfileMcpServer } from "./types.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SKEW_MS = 60_000;
const FETCH_MS = 15_000;

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
  obtainedAt: number;
}

export interface McpOAuthStatus {
  connected: boolean;
  expired?: boolean;
  expiresAt?: number;
  scope?: string;
}

export interface McpOAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
}

export interface StartMcpOAuthResult {
  authorizeUrl: string;
  state: string;
}

interface PendingOAuth {
  profileId: string;
  serverName: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  createdAt: number;
}

const pending = new Map<string, PendingOAuth>();

export function resetMcpOAuthPending(): void {
  pending.clear();
}

export function mcpOAuthRedirectUri(bindPort: number): string {
  return `http://127.0.0.1:${bindPort}/mcp/oauth/callback`;
}

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkce(
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function canonicalResource(url: string): string {
  const u = new URL(url);
  let path = u.pathname;
  if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.origin}${path === "/" ? "" : path}`;
}

/** RFC 9728 well-known URLs for a resource (path insert, then origin). */
export function protectedResourceMetadataUrls(mcpUrl: string): string[] {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") {
    urls.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  }
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** RFC 8414 + OIDC discovery URLs for an issuer. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  if (path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server${path}`,
      `${u.origin}/.well-known/openid-configuration${path}`,
      `${u.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`,
  ];
}

export function parseWwwAuthenticate(header: string): { resourceMetadata?: string; scope?: string } {
  const out: { resourceMetadata?: string; scope?: string } = {};
  const re = /([a-zA-Z0-9_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) {
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (key === "resource_metadata") out.resourceMetadata = val;
    if (key === "scope") out.scope = val;
  }
  return out;
}

export function oauthStorePath(dataDir: string, profileId: string, serverName: string): string {
  if (!NAME_RE.test(profileId) || !NAME_RE.test(serverName)) {
    throw new Error("invalid profile or MCP server name");
  }
  return join(dataDir, "mcp-oauth", profileId, `${serverName}.json`);
}

export function readOAuthTokens(
  dataDir: string,
  profileId: string,
  serverName: string,
): McpOAuthTokens | undefined {
  try {
    const path = oauthStorePath(dataDir, profileId, serverName);
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<McpOAuthTokens>;
    if (!raw.accessToken || !raw.clientId || !raw.tokenEndpoint || !raw.resource) return undefined;
    return {
      accessToken: String(raw.accessToken),
      refreshToken: raw.refreshToken ? String(raw.refreshToken) : undefined,
      tokenType: raw.tokenType ? String(raw.tokenType) : undefined,
      expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
      scope: raw.scope ? String(raw.scope) : undefined,
      clientId: String(raw.clientId),
      clientSecret: raw.clientSecret ? String(raw.clientSecret) : undefined,
      tokenEndpoint: String(raw.tokenEndpoint),
      resource: String(raw.resource),
      obtainedAt: typeof raw.obtainedAt === "number" ? raw.obtainedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeOAuthTokens(
  dataDir: string,
  profileId: string,
  serverName: string,
  tokens: McpOAuthTokens,
): void {
  const path = oauthStorePath(dataDir, profileId, serverName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
}

export function logoutMcpOAuth(dataDir: string, profileId: string, serverName: string): boolean {
  try {
    const path = oauthStorePath(dataDir, profileId, serverName);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function oauthStatus(
  dataDir: string,
  profileId: string,
  serverName: string,
  now: () => number = Date.now,
): McpOAuthStatus {
  const tok = readOAuthTokens(dataDir, profileId, serverName);
  if (!tok) return { connected: false };
  const expired = typeof tok.expiresAt === "number" && tok.expiresAt <= now();
  return {
    connected: !expired,
    expired: expired || undefined,
    expiresAt: tok.expiresAt,
    scope: tok.scope,
  };
}

export function mcpOAuthStatusMap(
  dataDir: string,
  profileId: string,
  servers: ProfileMcpServer[] | undefined,
  now: () => number = Date.now,
): Record<string, McpOAuthStatus> {
  const out: Record<string, McpOAuthStatus> = {};
  for (const s of servers ?? []) {
    if (!s.url) continue;
    out[s.name] = oauthStatus(dataDir, profileId, s.name, now);
  }
  return out;
}

function isFresh(tok: McpOAuthTokens, nowMs: number): boolean {
  if (!tok.accessToken) return false;
  if (typeof tok.expiresAt !== "number") return true;
  return tok.expiresAt > nowMs + SKEW_MS;
}

/** Sync Bearer header when a non-expired token is on disk. */
export function bearerHeaderIfFresh(
  dataDir: string,
  profileId: string,
  serverName: string,
  now: () => number = Date.now,
): Record<string, string> | undefined {
  const tok = readOAuthTokens(dataDir, profileId, serverName);
  if (!tok || !isFresh(tok, now())) return undefined;
  return { Authorization: `Bearer ${tok.accessToken}` };
}

export function oauthHeaderMap(
  dataDir: string,
  profileId: string,
  servers: ProfileMcpServer[] | undefined,
  now: () => number = Date.now,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const s of servers ?? []) {
    if (!s.url) continue;
    const h = bearerHeaderIfFresh(dataDir, profileId, s.name, now);
    if (h) out[s.name] = h;
  }
  return out;
}

export async function refreshAllMcpOAuth(
  dataDir: string,
  profileId: string,
  servers: ProfileMcpServer[] | undefined,
  deps: McpOAuthDeps = {},
): Promise<void> {
  for (const s of servers ?? []) {
    if (!s.url) continue;
    try {
      await refreshIfNeeded(dataDir, profileId, s.name, deps);
    } catch (err) {
      console.warn(
        `[mcp-oauth] refresh ${profileId}/${s.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function refreshIfNeeded(
  dataDir: string,
  profileId: string,
  serverName: string,
  deps: McpOAuthDeps = {},
): Promise<McpOAuthTokens | undefined> {
  const now = deps.now ?? Date.now;
  const tok = readOAuthTokens(dataDir, profileId, serverName);
  if (!tok) return undefined;
  if (isFresh(tok, now())) return tok;
  if (!tok.refreshToken) return tok;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tok.refreshToken,
    client_id: tok.clientId,
    resource: tok.resource,
  });
  if (tok.clientSecret) body.set("client_secret", tok.clientSecret);
  const json = await tokenRequest(tok.tokenEndpoint, body, deps);
  const next = tokensFromResponse(json, { ...tok, refreshToken: tok.refreshToken }, now());
  writeOAuthTokens(dataDir, profileId, serverName, next);
  return next;
}

export async function startMcpOAuth(opts: {
  dataDir: string;
  profileId: string;
  serverName: string;
  mcpUrl: string;
  redirectUri: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  deps?: McpOAuthDeps;
}): Promise<StartMcpOAuthResult> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ?? nodeRandomBytes;
  const fetchImpl = deps.fetch ?? fetch;

  const resource = canonicalResource(opts.mcpUrl);
  const discovered = await discoverOAuth(opts.mcpUrl, fetchImpl);
  const scope =
    opts.scope?.trim() ||
    discovered.scope?.trim() ||
    (discovered.scopesSupported ?? []).join(" ");

  let clientId = opts.clientId?.trim() || "";
  let clientSecret = opts.clientSecret?.trim() || undefined;
  if (!clientId) {
    if (!discovered.registrationEndpoint) {
      throw new Error(
        "MCP authorization server has no registration_endpoint — add oauthClientId to this server JSON",
      );
    }
    const reg = await registerClient({
      endpoint: discovered.registrationEndpoint,
      redirectUri: opts.redirectUri,
      fetchImpl,
    });
    clientId = reg.clientId;
    clientSecret = reg.clientSecret ?? clientSecret;
  }

  const pkce = generatePkce(randomBytes);
  const state = b64url(randomBytes(24));
  pending.set(state, {
    profileId: opts.profileId,
    serverName: opts.serverName,
    codeVerifier: pkce.verifier,
    redirectUri: opts.redirectUri,
    tokenEndpoint: discovered.tokenEndpoint,
    clientId,
    clientSecret,
    resource,
    createdAt: now(),
  });

  const auth = new URL(discovered.authorizationEndpoint);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", opts.redirectUri);
  auth.searchParams.set("code_challenge", pkce.challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("state", state);
  auth.searchParams.set("resource", resource);
  if (scope) auth.searchParams.set("scope", scope);
  return { authorizeUrl: auth.toString(), state };
}

export async function completeMcpOAuth(opts: {
  dataDir: string;
  state: string;
  code: string;
  deps?: McpOAuthDeps;
}): Promise<{ profileId: string; serverName: string }> {
  const pendingFlow = pending.get(opts.state);
  pending.delete(opts.state);
  if (!pendingFlow) throw new Error("unknown or expired OAuth state");
  const now = opts.deps?.now ?? Date.now;
  if (now() - pendingFlow.createdAt > 15 * 60 * 1000) {
    throw new Error("OAuth state expired — start Sign in again");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: pendingFlow.redirectUri,
    client_id: pendingFlow.clientId,
    code_verifier: pendingFlow.codeVerifier,
    resource: pendingFlow.resource,
  });
  if (pendingFlow.clientSecret) body.set("client_secret", pendingFlow.clientSecret);
  const json = await tokenRequest(pendingFlow.tokenEndpoint, body, opts.deps ?? {});
  const tokens = tokensFromResponse(
    json,
    {
      clientId: pendingFlow.clientId,
      clientSecret: pendingFlow.clientSecret,
      tokenEndpoint: pendingFlow.tokenEndpoint,
      resource: pendingFlow.resource,
    },
    now(),
  );
  writeOAuthTokens(opts.dataDir, pendingFlow.profileId, pendingFlow.serverName, tokens);
  return { profileId: pendingFlow.profileId, serverName: pendingFlow.serverName };
}

interface Discovered {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
  scopesSupported?: string[];
}

async function discoverOAuth(mcpUrl: string, fetchImpl: typeof fetch): Promise<Discovered> {
  let scopeFromChallenge: string | undefined;
  const metadataUrls: string[] = [];
  try {
    const probe = await fetchImpl(mcpUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_MS),
      headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-11-25" },
    });
    const www = probe.headers.get("www-authenticate") ?? "";
    const parsed = parseWwwAuthenticate(www);
    if (parsed.resourceMetadata) metadataUrls.push(parsed.resourceMetadata);
    scopeFromChallenge = parsed.scope;
  } catch {
    /* well-known fallback */
  }
  for (const u of protectedResourceMetadataUrls(mcpUrl)) {
    if (!metadataUrls.includes(u)) metadataUrls.push(u);
  }

  let resourceMeta: {
    authorization_servers?: string[];
    scopes_supported?: string[];
  } | null = null;
  for (const u of metadataUrls) {
    resourceMeta = await jsonGet<{
      authorization_servers?: string[];
      scopes_supported?: string[];
    }>(u, fetchImpl).catch(() => null);
    if (resourceMeta?.authorization_servers?.length) break;
  }
  if (!resourceMeta?.authorization_servers?.length) {
    throw new Error(`no OAuth protected-resource metadata at ${mcpUrl}`);
  }

  const issuer = resourceMeta.authorization_servers[0]!;
  type AsMeta = {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    scopes_supported?: string[];
  };
  let asMeta: AsMeta | null = null;
  for (const u of authorizationServerMetadataUrls(issuer)) {
    asMeta = await jsonGet<AsMeta>(u, fetchImpl).catch(() => null);
    if (asMeta?.authorization_endpoint && asMeta.token_endpoint) break;
  }
  if (!asMeta?.authorization_endpoint || !asMeta.token_endpoint) {
    throw new Error(`no authorization-server metadata at ${issuer}`);
  }
  const methods = asMeta.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.length > 0 && !methods.includes("S256")) {
    throw new Error("authorization server does not advertise PKCE S256");
  }
  return {
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint: asMeta.registration_endpoint,
    scope: scopeFromChallenge,
    scopesSupported: resourceMeta.scopes_supported ?? asMeta.scopes_supported,
  };
}

async function registerClient(opts: {
  endpoint: string;
  redirectUri: string;
  fetchImpl: typeof fetch;
}): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await opts.fetchImpl(opts.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_MS),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "ClankerSpanker",
      redirect_uris: [opts.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    client_id?: string;
    client_secret?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.client_id) {
    throw new Error(
      json.error_description || json.error || `dynamic client registration failed (${res.status})`,
    );
  }
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

async function jsonGet<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function tokenRequest(
  tokenEndpoint: string,
  body: URLSearchParams,
  deps: McpOAuthDeps,
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    const desc = String(json.error_description || json.error || `token request failed (${res.status})`);
    throw new Error(desc);
  }
  return json;
}

function tokensFromResponse(
  json: Record<string, unknown>,
  prev: {
    clientId: string;
    clientSecret?: string;
    tokenEndpoint: string;
    resource: string;
    refreshToken?: string;
  },
  nowMs: number,
): McpOAuthTokens {
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    accessToken: String(json.access_token),
    refreshToken:
      typeof json.refresh_token === "string" ? json.refresh_token : prev.refreshToken,
    tokenType: typeof json.token_type === "string" ? json.token_type : "Bearer",
    expiresAt: expiresIn != null ? nowMs + expiresIn * 1000 : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    clientId: prev.clientId,
    clientSecret: prev.clientSecret,
    tokenEndpoint: prev.tokenEndpoint,
    resource: prev.resource,
    obtainedAt: nowMs,
  };
}
