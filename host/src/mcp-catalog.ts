import type { ProfileMcpServer } from "./types.js";
import { normalizeMcpServers } from "./mcp.js";

export type McpCatalogTransport = "http" | "stdio" | "sse";

/** One vendor connector operators can attach to a profile. No secrets. */
export interface McpCatalogServer {
  id: string;
  vendor: string;
  transport: McpCatalogTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth: string;
  notes?: string;
  /** Shown as a chip, omitted from Apply catalog defaults. */
  optional?: boolean;
}

/**
 * Default MCP ids per profile (payer isolation). Unknown ids get `[]`.
 * Gemini stays empty until Antigravity grows `--mcp-config`.
 */
export const MCP_CATALOG_ASSIGNMENTS: Record<string, readonly string[]> = {
  nightmoose: ["github", "vercel", "supabase", "notion", "fly"],
  personal: ["github", "notion"],
  fullscore: ["databricks", "azure-devops", "azure"],
  gemini: [],
};

/** Checked-in catalog. Keep fenced JSON in docs/MCP-CATALOG.md in sync. */
export const MCP_CATALOG: readonly McpCatalogServer[] = [
  {
    id: "github",
    vendor: "GitHub",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    auth: "GITHUB_TOKEN in Environment (gh PAT or `gh auth token`)",
    notes: "GitHub MCP has no Sign in (no DCR). Each profile can have its own token.",
  },
  {
    id: "vercel",
    vendor: "Vercel",
    transport: "http",
    url: "https://mcp.vercel.com",
    auth: "OAuth",
    notes: "Smolder, Drea, ContractGate, Mercenary, Dirt Work, BlessingBox",
  },
  {
    id: "supabase",
    vendor: "Supabase",
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    auth: "OAuth",
    notes: "BlessingBox, Smolder, Dirt Work, Mercenary",
  },
  {
    id: "notion",
    vendor: "Notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    auth: "OAuth",
    notes: "Ops notes / product docs",
  },
  {
    id: "fly",
    vendor: "Fly.io",
    transport: "stdio",
    command: "flyctl",
    args: ["mcp", "server"],
    auth: "flyctl login",
    notes: "Uses the flyctl session already on this Mac",
  },
  {
    id: "databricks",
    vendor: "Databricks",
    transport: "stdio",
    command: "npx",
    args: ["-y", "databricks-mcp"],
    env: { DATABRICKS_TOKEN: "${DATABRICKS_TOKEN}" },
    auth: "PAT in profile env",
    notes: "FullScore client data; put DATABRICKS_TOKEN in Environment",
  },
  {
    id: "azure-devops",
    vendor: "Azure DevOps",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@azure-devops/mcp", "ShoreCP"],
    auth: "interactive Entra (browser on first tool use)",
    notes: "FullScore org ShoreCP. Remote HTTP Sign in needs an Entra app oauthClientId; stdio is the working path.",
  },
  {
    id: "azure",
    vendor: "Microsoft Azure",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@azure/mcp@latest", "server", "start"],
    auth: "az login / DefaultAzureCredential",
    notes: "Data Factory / storage / Fabric-adjacent. Remote HTTP Entra has no DCR.",
  },
  {
    id: "linear",
    vendor: "Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    auth: "OAuth",
    optional: true,
  },
  {
    id: "context7",
    vendor: "Context7",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    auth: "OAuth",
    optional: true,
    notes: "Current library docs",
  },
];

export function catalogById(id: string): McpCatalogServer | undefined {
  const key = id.trim().toLowerCase();
  return MCP_CATALOG.find((s) => s.id === key);
}

export function defaultCatalogIdsFor(profileId: string): string[] {
  const key = profileId.trim().toLowerCase();
  const ids = MCP_CATALOG_ASSIGNMENTS[key];
  return ids ? [...ids] : [];
}

export function catalogServerToProfile(server: McpCatalogServer): ProfileMcpServer {
  const entry: ProfileMcpServer = {
    name: server.id,
    transport: server.transport,
  };
  if (server.url) entry.url = server.url;
  if (server.command) entry.command = server.command;
  if (server.args?.length) entry.args = [...server.args];
  if (server.env && Object.keys(server.env).length) entry.env = { ...server.env };
  if (server.headers && Object.keys(server.headers).length) entry.headers = { ...server.headers };
  return entry;
}

/**
 * Merge catalog defaults onto a profile. Existing same-name rows win
 * unless `replace` is set. Unknown profile ids get an empty default list
 * (merge keeps what is already there).
 */
export function applyCatalogDefaults(
  profileId: string,
  existing?: ProfileMcpServer[] | null,
  opts?: { replace?: boolean },
): ProfileMcpServer[] | undefined {
  const defaults = defaultCatalogIdsFor(profileId)
    .map((id) => catalogById(id))
    .filter((s): s is McpCatalogServer => Boolean(s))
    .map(catalogServerToProfile);
  const incoming = opts?.replace ? defaults : [...(existing ?? []), ...defaults];
  return normalizeMcpServers(incoming);
}

export function publicMcpCatalog(): {
  servers: McpCatalogServer[];
  assignments: Record<string, string[]>;
} {
  return {
    servers: MCP_CATALOG.map((s) => ({ ...s })),
    assignments: Object.fromEntries(
      Object.entries(MCP_CATALOG_ASSIGNMENTS).map(([id, ids]) => [id, [...ids]]),
    ),
  };
}
