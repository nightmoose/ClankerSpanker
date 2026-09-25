import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oauthHeaderMap } from "./mcp-oauth.js";
import type { AgentProfile, ProfileMcpServer } from "./types.js";

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function expandVars(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => env[key] ?? "");
}

function recordToPairs(
  rec: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Array<{ name: string; value: string }> {
  if (!rec) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, raw] of Object.entries(rec)) {
    const n = name.trim();
    if (!n) continue;
    out.push({ name: n, value: expandVars(String(raw ?? ""), env) });
  }
  return out;
}

function pairsToRecord(pairs: Array<{ name: string; value: string }>): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const p of pairs) rec[p.name] = p.value;
  return rec;
}

function mergeHeaders(
  configured: Record<string, string>,
  oauth?: Record<string, string>,
): Record<string, string> {
  const out = { ...configured };
  if (!oauth) return out;
  for (const [k, v] of Object.entries(oauth)) {
    const clash = Object.keys(out).some((h) => h.toLowerCase() === k.toLowerCase());
    if (!clash) out[k] = v;
  }
  return out;
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([k, v]) => k.toLowerCase() === "authorization" && v.trim().length > 0,
  );
}

export function normalizeMcpServers(raw?: ProfileMcpServer[] | null): ProfileMcpServer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProfileMcpServer[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    const name = s?.name?.trim() ?? "";
    if (!name || !NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const command = s.command?.trim() || undefined;
    const url = s.url?.trim() || undefined;
    if (!command && !url) continue;
    const transportRaw = (s.transport ?? "").trim().toLowerCase();
    const transport: ProfileMcpServer["transport"] =
      transportRaw === "sse" || transportRaw === "http" || transportRaw === "stdio"
        ? transportRaw
        : url
          ? "http"
          : "stdio";
    const args = Array.isArray(s.args)
      ? s.args.map((a) => String(a)).filter((a) => a.length > 0)
      : undefined;
    const env =
      s.env && typeof s.env === "object"
        ? Object.fromEntries(
            Object.entries(s.env)
              .filter(([k]) => k.trim())
              .map(([k, v]) => [k.trim(), String(v ?? "")]),
          )
        : undefined;
    const headers =
      s.headers && typeof s.headers === "object"
        ? Object.fromEntries(
            Object.entries(s.headers)
              .filter(([k]) => k.trim())
              .map(([k, v]) => [k.trim(), String(v ?? "")]),
          )
        : undefined;
    const entry: ProfileMcpServer = {
      name,
      enabled: s.enabled === false ? false : undefined,
      command,
      args: args?.length ? args : undefined,
      env: env && Object.keys(env).length ? env : undefined,
      url,
      headers: headers && Object.keys(headers).length ? headers : undefined,
      transport,
    };
    const oauthClientId = s.oauthClientId?.trim();
    const oauthClientSecret = s.oauthClientSecret?.trim();
    const oauthScope = s.oauthScope?.trim();
    if (oauthClientId) entry.oauthClientId = oauthClientId;
    if (oauthClientSecret) entry.oauthClientSecret = oauthClientSecret;
    if (oauthScope) entry.oauthScope = oauthScope;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

export function enabledMcpServers(servers?: ProfileMcpServer[] | null): ProfileMcpServer[] {
  return (servers ?? []).filter((s) => s.enabled !== false);
}

export function publicMcpServers(
  servers?: ProfileMcpServer[] | null,
): Array<{ name: string; enabled?: boolean; command?: string; url?: string; transport?: string }> {
  return (servers ?? []).map((s) => ({
    name: s.name,
    enabled: s.enabled,
    command: s.command,
    url: s.url,
    transport: s.transport,
  }));
}

/** Claude `.mcp.json` body (`--mcp-config`). */
export function toMcpJson(
  servers: ProfileMcpServer[] | undefined,
  env: Record<string, string | undefined>,
  oauthHeaders?: Record<string, Record<string, string>>,
): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const s of enabledMcpServers(servers)) {
    const entry: Record<string, unknown> = {};
    if (s.url) {
      const merged = mergeHeaders(pairsToRecord(recordToPairs(s.headers, env)), oauthHeaders?.[s.name]);
      // Grok ACP treats HTTP 401 AuthRequired as a fatal worker exit (RFC-012).
      if (!hasAuthorizationHeader(merged)) continue;
      entry.url = expandVars(s.url, env);
      if (Object.keys(merged).length) entry.headers = merged;
      // Claude's schema requires `type` on URL servers; `transport` is rejected (RFC-054).
      entry.type = s.transport === "sse" ? "sse" : "http";
    } else if (s.command) {
      const e = recordToPairs(s.env, env);
      // Empty ${DATABRICKS_TOKEN} (etc.) made Claude exit 1.
      if (e.some((p) => !p.value.trim())) continue;
      entry.command = expandVars(s.command, env);
      entry.args = (s.args ?? []).map((a) => expandVars(a, env));
      if (e.length) entry.env = pairsToRecord(e);
    } else {
      continue;
    }
    mcpServers[s.name] = entry;
  }
  return { mcpServers };
}

export type AcpMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }
  | {
      type: "http" | "sse";
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };

/** ACP `session/new` / `session/load` mcpServers list. */
export function toAcpMcpServers(
  servers: ProfileMcpServer[] | undefined,
  env: Record<string, string | undefined>,
  oauthHeaders?: Record<string, Record<string, string>>,
): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  for (const s of enabledMcpServers(servers)) {
    if (s.url) {
      const merged = mergeHeaders(pairsToRecord(recordToPairs(s.headers, env)), oauthHeaders?.[s.name]);
      if (!hasAuthorizationHeader(merged)) continue;
      out.push({
        type: s.transport === "sse" ? "sse" : "http",
        name: s.name,
        url: expandVars(s.url, env),
        headers: Object.entries(merged).map(([name, value]) => ({ name, value })),
      });
    } else if (s.command) {
      const e = recordToPairs(s.env, env);
      if (e.some((p) => !p.value.trim())) continue;
      out.push({
        name: s.name,
        command: expandVars(s.command, env),
        args: (s.args ?? []).map((a) => expandVars(a, env)),
        env: e,
      });
    }
  }
  return out;
}

export function writeProfileMcpJson(
  dataDir: string,
  profile: AgentProfile,
  env: Record<string, string | undefined>,
): string | undefined {
  const enabled = enabledMcpServers(profile.mcpServers);
  if (!enabled.length) return undefined;
  const body = toMcpJson(
    profile.mcpServers,
    env,
    oauthHeaderMap(dataDir, profile.id, profile.mcpServers),
  );
  if (!Object.keys(body.mcpServers).length) return undefined;
  const dir = join(dataDir, "mcp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${profile.id}.mcp.json`);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function claudeMcpConfigArgs(mcpConfigPath?: string): string[] {
  if (!mcpConfigPath) return [];
  return ["--mcp-config", mcpConfigPath];
}

export function mcpEnvFor(profile: AgentProfile): Record<string, string | undefined> {
  return { ...process.env, ...(profile.env ?? {}) };
}
