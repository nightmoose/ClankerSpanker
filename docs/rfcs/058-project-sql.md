# RFC-058 — Per-project SQL execution + sealed-input secrets

**Status:** Draft
**Date:** 2026-10-13
**Branch:** nightly-maintenance-2026-10-13-rfc058-project-sql
**Severity:** P1

---

## Problem

Every project in ClankerSpanker has its own Supabase database, and Alex
regularly needs to run SQL against them while a session is open (schema
tweaks, data checks, one-off fixes). Today there is no way: the terminal
runs shell on the host, not SQL, and the only alternative is leaving
ClankerSpanker to open a Supabase SQL editor — which breaks the
agent-in-the-loop idiom and hides the query/output from the transcript.

Secondary problem: a Supabase connection string carries a service-role
password. Pasting it into a chat so the agent can call `psql` would land
it in the transcript, token logs, and context windows forever. The host
needs a way for the agent to **request** a secret from the user without
ever seeing the value.

## Non-goals

- Read-only variant / least-privilege DB roles (service role is fine for v1).
- Multiple databases per project (one slot; staging/prod are separate projects
  in practice).
- Keychain-backed encryption-at-rest for the secret. The connection string
  lands next to today's `profile.env` API keys in the config JSON; disk
  encryption is a fast-follow.
- Non-Supabase providers (Postgres pooler URLs happen to work regardless;
  the UI calls it "Supabase").
- Auto-approval of SQL tool calls. Every query goes through the normal
  Approve/Reject gate.
- API-key slots for other tools (webhooks, OAuth). The primitive supports
  them; wiring is a fast-follow.

## Fix

### Data model (`host/src/types.ts`)

```ts
export interface ProjectDatabase {
  provider: "supabase";
  /** Pointer into the project's secret slots; opaque to the client. */
  connectionRef: string;
  /** Display-only hint, e.g. "db.abc.supabase.co" — never the password. */
  hostHint?: string;
  addedAt: string;
  updatedAt: string;
}

export interface ProjectInfo {
  // …existing fields
  database?: ProjectDatabase;
}
```

Secret slots live in the project JSON under a sibling field that is
scrubbed on `publicProject()` the way `profile.env` is on
`publicProfile()`:

```ts
interface ProjectSecrets { [slot: string]: string }   // never echoed on read
```

### Sealed-input primitive (`host/src/approvals/secret-request.ts`)

New tool kind `"secret_request"`:

```ts
rawInput: {
  slot: string;              // e.g. "project.database_connection"
  purpose: string;           // agent's stated reason, shown in the modal
  hint?: string;             // optional placeholder (e.g. "postgres://…")
}
```

Handler:

1. Register as a `PendingApproval` with a new `kind: "secret_request"`.
2. Push the usual `approval.needed` event. Clients render the sealed-input
   modal (SecureField) instead of the Approve/Reject bar.
3. On save, host POST `/sessions/:id/secret` with `{ approvalId, value }`.
4. Host writes `value` to `projectSecrets[slot]` (project JSON, 0600
   perms via existing `config-perms`), updates `project.database.connectionRef`
   if the slot matches, resolves the tool with `{ ok: true, slot }`.
5. The raw value is **not** returned to the agent, logged, or echoed in
   events. Request-log scrubbing covers `kind: "secret_request"` payloads.

### `sql_execute` tool (`host/src/tools/sql.ts`)

```ts
rawInput: { query: string }
```

- Session's project resolved via existing `inferProjectId(session.cwd)`.
- Connection string loaded from `projectSecrets[project.database.connectionRef]`.
- Missing config → tool resolves with `{ error: "no_database_configured" }`;
  the agent naturally follows up with `secret_request`.
- Executes via `pg` (`Pool` with 1 connection, 30s statement timeout).
- Result shape: `{ rowCount, columns, rows }` with 50-row / 32 KB preview
  cap for `tool_call_update.outputPreview`; full result returned to agent.
- Normal `PendingApproval` flow; **not** in `autoApproveKinds`. The
  approval card syntax-highlights the SQL and flags DDL/UPDATE/DELETE in
  the title.

### Multi-host

SQL executes on the host that owns the session (same as every other
tool). Secrets live in that host's `~/.grok-dispatch/config.json`, so a
project opened on two hosts has to be configured on each — same model as
`profile.env` today. Acceptable for v1; multi-host sync is tracked in
`project_multi_host_gap`.

### Client UI

- **Mac** (`apps/mac/.../Views/Session/`): `SecretRequestModal.swift` with
  `SecureField`, purpose line, slot line, Save/Cancel. `ApprovalBarView`
  routes `kind == "secret_request"` to the modal; `kind == "sql"` to a
  SQL-highlighted preview card. Project edit sheet gets a "Database"
  section: label, host hint, "Set connection string" (re-triggers the
  modal flow without the agent), "Clear".
- **iOS**: same two components. SecureField with autofill disabled.
- **Linux Electron** (`desktop/renderer/`): same.

## Testing

- [ ] `secret-request.test.ts` — handler writes to secrets, does not
      echo value in resolve payload, scrubbed from request log.
- [ ] `sql-execute.test.ts` — missing config path, happy path (mock pg),
      row cap, DDL flag in title.
- [ ] `project-secret-scrub.test.ts` — `publicProject()` never returns
      `projectSecrets`.
- [ ] `openapi-contract.test.ts` — new routes `/sessions/:id/secret`,
      `/projects/:id/database`.
- [ ] Manual soak (Mac, then iOS, then Linux): project with no DB → ask
      Grok to run `select 1` → modal appears → paste conn string →
      approval card for the query → row appears in transcript. Reject
      path. "Set connection string" from project sheet without an agent.

## Rollout

1. Backend commits (types → secret_request → sql_execute).
2. Mac client commit; `make check`.
3. iOS client commit; `make check`.
4. Linux Electron commit; `make check`.
5. `npm run build`; kill port-8787 PID so LaunchAgent reloads.
6. Update `docs/rfcs/README.md` row to **Shipped**; log in
   `docs/STATUS.md` / `MAINTENANCE_LOG.md`.

## Follow-ups

- Keychain / libsecret-backed secret slots (encrypt at rest).
- API-key slots using the same primitive (OpenAI/Anthropic in profile
  env migrate here).
- Multiple databases per project (staging + prod with a picker).
- SSH tunnel + bastion support for Postgres instances not exposed on the
  public internet.
- Multi-host secret sync (part of the multi-host architectural work).
