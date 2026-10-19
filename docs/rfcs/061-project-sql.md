# RFC-061 — Project database binding, sealed-input secrets, and `sql_execute`

**Status:** Draft
**Date:** 2026-10-13 (revised 2026-10-19)
**Branch:** nightly-maintenance-2026-10-13-rfc058-project-sql
**Severity:** P2
**Renumbered:** 2026-10-19, from RFC-058. 058 is the hosted product site on `main`; 059 is host
self-update. The branch name keeps the old number.
**RFC-062:** the follow-on that was going to carry `sql_execute` is delivered by this RFC and
this PR (see [Agent tool](#agent-tool-sql_execute)). No `062-*.md` file was ever written and
nothing else points at the number.

---

## Problem

Every project in ClankerSpanker has its own Supabase database, and the user
needs to run SQL against it from inside a session. The agent must not be
handed a service-role connection string in a chat message: it would sit in
the transcript, the context window and the token logs forever. The host
needs:

1. A place to persist a project's connection string that is **not**
   `ProjectInfo` on the wire.
2. A primitive for asking the user for a secret the agent must never see.
3. An agent-callable `sql_execute` tool that uses (1) without the agent ever
   receiving the value.

## Non-goals

- Keychain / libsecret encryption at rest. The secret lands next to
  `profile.env` API keys in the config JSON (0600).
- Non-Supabase providers or several databases per project. One slot per
  project; the UI says "Supabase" but any Postgres URL works.
- Protecting the secret from an agent that sets out to steal it. The agent
  runs as the same OS user as the host and can read `config.json` with its
  shell tool. This RFC keeps the value out of everything the agent is
  *given* (prompt, transcript, tool output, profile, `/projects`), not out of
  reach of a hostile process. Use a read-only database role for real limits.
- Agent-triggered sealed input (the agent asking the host to prompt for a
  secret). The primitive exists; no agent path calls it yet.

## Fix

### Data model (`host/src/types.ts`)

```ts
export interface ProjectDatabase {
  provider: "supabase";
  /** Pointer into HostConfigFile.projectSecrets; opaque to the client. */
  connectionRef: string;
  /** Display-only, e.g. "db.abc.supabase.co"; never the password. */
  hostHint?: string;
  addedAt: string;
  updatedAt: string;
}

export interface ProjectInfo   { /* … */ database?: ProjectDatabase }
export interface HostConfigFile { /* … */ projectSecrets?: Record<string, Record<string, string>> }
```

No route serializes `projectSecrets`. `ProjectInfo.database` carries only
metadata.

### Secret store (`host/src/project-secrets.ts`)

`get` / `set` / `remove` / `removeAllForProject`, slot
`DATABASE_CONNECTION_SLOT = "project.database_connection"`. One file owns
every read and write so later audit or encryption work touches one place.

### Routes (`host/src/server.ts`)

- `POST /projects/:id/database`, body `{ connectionString, hostHint? }`.
  Stores the value through `project-secrets.set` and attaches the
  `database` block. When the client sends no `hostHint` the host uses the
  URL's hostname. The response is the public `ProjectInfo`.
- `DELETE /projects/:id/database` clears the slot and the block. Idempotent.
- Validation: non-empty, `postgres://` or `postgresql://`. Errors never
  include the supplied value.
- `DELETE /projects/:id?hard=1` calls `removeAllForProject`.
- `PATCH /projects/:id` ignores a `database` field in the body. Only the two
  routes above change the binding, so a client echoing a stale project
  cannot fake or resurrect one.

**Who may call them.** Both routes need the host token and nothing more,
like every other project edit. That covers a phone over Tailscale, a
`tailscale serve` caller (RFC-058 phase 2, which also needs the
`Tailscale-User-Login` header on that listener), and the hosted UI at
`https://clankerspanker.tech` (CORS reflects that origin for `POST` and
`DELETE`). They are write-only, so a remote caller can replace or clear the
binding but never read it back. Profile admin stays local-only because it
returns secrets; these routes do not.

### Sealed-input primitive (`host/src/sealed-input.ts`)

A standalone manager parallel to `PendingQuestion`, so the 150-line
`resolveApproval` does not grow a secret-carrying branch:

- `PendingSecretRequest { id, sessionId, projectId, slot, purpose, hint, createdAt, expiresAt? }`.
- Events `secret.needed` / `secret.resolved` carry slot metadata, never the value.
- `request()` returns a promise; `submit(id, value)` writes through an
  injected `writeSecret` and resolves `{ ok: true, slot }`; `cancel` and
  TTL expiry resolve `{ ok: false }`.
- No production caller yet (see Non-goals).

### Agent tool: `sql_execute`

`host/src/mcp/sql-execute.ts` is a stdio MCP server with one tool,
`sql_execute { query: string, params?: unknown[] }`.

**Injection.** When a session's project has a bound database, the host adds
a server named `sql` (`projectSqlMcpServer` in `host/src/mcp.ts`) for that
session only. It is never written to a profile, so `/profiles` cannot show
it, and a profile server also named `sql` is replaced for that session.

- Grok (ACP): appended to `session/new` / `session/load` `mcpServers`, with
  `DATABASE_URL` in the server's env. The value is not passed through
  `${VAR}` expansion.
- Claude: written into the `--mcp-config` file. With a database the file is
  `mcp/<profile>.<session>.mcp.json` (0600), not the shared per-profile
  file, so two sessions on one profile in different projects cannot read
  each other's database. The file is deleted when the turn ends and when
  the session is deleted.

**Execution.**

1. The query must start with `SELECT`, `EXPLAIN`, `SHOW` or `WITH`.
2. It runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, so
   data-modifying CTEs and `EXPLAIN ANALYZE DELETE …` fail.
3. It runs with the extended query protocol, which accepts one statement,
   so `select 1; commit; drop table t` cannot leave the transaction.
4. `statement_timeout` 10 s, one pooled connection, at most 200 rows
   returned (with `truncated: true` and a note). Postgres still sends the
   whole result to the MCP process before the cap applies.

**Secret handling.** The URL comes only from the env the host set. Every
error sent back (tool errors and JSON-RPC errors) goes through
`redactSecret`, which removes the URL, its password (raw and decoded) and
any other credentialed `postgres://` URL.

Read-only mode is a guard, not a permission boundary: functions with side
effects (`pg_terminate_backend`, `dblink`, …) still run. Bind a role with
read-only grants.

### Clients

- Mac / iOS (`ProjectEditorView`): inline "connect database" field;
  disconnect button; shows `hostHint`.
- Linux Electron (`desktop/renderer/app.js`): prompt-based connect /
  disconnect after editing a project.
- Browser UI: none yet.

## Testing

- [x] `project-secrets.test.ts`: set/get/remove, per-project isolation,
      bucket cleanup, project shape never serializes the value.
- [x] `sealed-input.test.ts`: request/submit/cancel/expire, no value in
      event payloads, `cancelForSession`, `listForSession`.
- [x] `mcp/sql-execute.test.ts`: tool listing, JSON-RPC errors, argument
      validation before any connection, READ ONLY + extended protocol +
      rollback and release on error, 200-row cap, redaction of database and
      connection errors, and the real stdio entry point (no `DATABASE_URL`
      → exit 1; a refused loopback connection comes back redacted). The
      Postgres pool is faked; no database is used.
- [x] `mcp.test.ts`: per-session Claude config, 0600, literal value, two
      sessions kept apart, stale file removed.
- [x] `project-database.test.ts`: routes through the real gateway on the
      main and `tailscale serve` listeners, hosted-origin CORS, no secret on
      `/projects`, `/projects/:id`, `/profiles`, `/sessions` or in logs,
      `PATCH` cannot change the binding, hard delete clears the slot, and
      ACP injection only for the bound project's sessions.
- [ ] By hand: a real Supabase project, a Grok session and a Claude session
      each calling `sql_execute`, then `DELETE` and confirm the tool is gone
      on the next turn.

## Follow-ups

- Keychain / libsecret-backed slots; API-key slots on the same primitive.
- Agent-triggered sealed input (agent asks, user types into a host modal).
- Stream rows with a cursor instead of capping after the fetch.
- Browser UI for connect / disconnect.
- Sessions with no resolvable profile get no `sql` server today.
- SSH tunnel / bastion for private databases.
