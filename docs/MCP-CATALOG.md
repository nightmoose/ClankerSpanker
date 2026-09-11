# MCP catalog — paste onto a profile

RFC: [rfcs/013-profile-mcp-catalog.md](rfcs/013-profile-mcp-catalog.md).
Mechanism: [MCP.md](MCP.md) (RFC-008/009).

`/app/` → Profiles (this Mac) → MCP JSON textarea. HTTP rows then
**Sign in**. Do not put Gmail / M365 / QuickBooks on NightMoose.

Placeholders: replace `YOUR_ADO_ORG`. Tokens belong in that profile’s
**Environment** field (`${DATABRICKS_TOKEN}`), never in git.

---

## NightMoose (Grok)

```json
[
  {
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "transport": "http"
  },
  {
    "name": "vercel",
    "url": "https://mcp.vercel.com",
    "transport": "http"
  },
  {
    "name": "supabase",
    "url": "https://mcp.supabase.com/mcp",
    "transport": "http"
  },
  {
    "name": "notion",
    "url": "https://mcp.notion.com/mcp",
    "transport": "http"
  },
  {
    "name": "fly",
    "command": "flyctl",
    "args": ["mcp", "server"]
  }
]
```

Sign in: GitHub, Vercel, Supabase, Notion. Fly uses the `flyctl` login
already on this Mac (`fly auth whoami`).

Optional later: `stripe`, `sentry`, `context7`
(`https://mcp.context7.com/mcp`), `linear`
(`https://mcp.linear.app/mcp`).

---

## Personal (Claude)

```json
[
  {
    "name": "github",
    "url": "https://api.githubcopilot.com/mcp/",
    "transport": "http"
  },
  {
    "name": "notion",
    "url": "https://mcp.notion.com/mcp",
    "transport": "http"
  }
]
```

Sign in **again** on this chip (separate OAuth files under
`mcp-oauth/personal/`). Add Gmail/Slack here, not on NightMoose.

---

## FullScore (Claude)

```json
[
  {
    "name": "databricks",
    "command": "npx",
    "args": ["-y", "databricks-mcp"],
    "env": { "DATABRICKS_TOKEN": "${DATABRICKS_TOKEN}" }
  },
  {
    "name": "azure-devops",
    "url": "https://mcp.dev.azure.com/YOUR_ADO_ORG",
    "transport": "http"
  },
  {
    "name": "azure",
    "url": "https://mcp.management.azure.com",
    "transport": "http"
  }
]
```

If Azure DevOps remote Sign in fails (Entra often wants a
pre-registered client, not DCR), use local stdio instead:

```json
{
  "name": "azure-devops",
  "command": "npx",
  "args": ["-y", "@azure-devops/mcp"]
}
```

Databricks workspace URL, if the vendor HTTP server is used instead of
npx, is per-customer — keep it in FullScore env, not in this file.

---

## Gemini

Leave `[]` until Antigravity grows `--mcp-config`.

---

## Vendor notes

| Server | Canonical | Auth |
|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp/` | OAuth |
| Vercel | `https://mcp.vercel.com` | OAuth (this is what crashed unsigned NightMoose turns) |
| Supabase | `https://mcp.supabase.com/mcp` | OAuth; stdio `@supabase/mcp-server-supabase` if remote flakes |
| Notion | `https://mcp.notion.com/mcp` | OAuth |
| Fly.io | `flyctl mcp server` | existing flyctl session |
| Azure DevOps | `https://mcp.dev.azure.com/{org}` | Entra; stdio fallback `@azure-devops/mcp` |
| Azure | `https://mcp.management.azure.com` | Entra (Data Factory / cloud data plane) |
| Databricks | workspace-specific or `npx -y databricks-mcp` | PAT |

---

## Soak

1. Paste NightMoose JSON, Sign in Vercel, dispatch, tools include Vercel.
2. FullScore turn on the same host: **no** Vercel tools.
3. Unsigned Vercel must **not** pop “NightMoose needs to sign in”
   (RFC-012). Prefer Sign in or `enabled: false` over a dead worker.
