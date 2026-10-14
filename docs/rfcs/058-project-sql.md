# RFC-058 — Project database binding + sealed-input primitive

**Status:** Draft
**Date:** 2026-10-13
**Branch:** nightly-maintenance-2026-10-13-rfc058-project-sql
**Severity:** P2

---

## Problem

Every project in ClankerSpanker has its own Supabase database and Alex
needs to run SQL against them from inside a session — but the agent
cannot be handed a service-role connection string in a chat message
(transcript, context window, token logs forever). The host needs:

1. A place to persist a project's database connection string that is
   **not** `ProjectInfo` on the wire.
2. A primitive for prompting the user to supply a secret the agent must
   never see.
3. (Eventually) an agent-callable `sql_execute` tool that uses both.

(3) is deferred. Making the agent emit a `sql_execute` tool call
requires wiring a built-in MCP server into every profile's `mcpServers`
list, which collides with the "backend parity before MCP" decision
(2026-08-28). RFC-059 picks that up once the parity pass is further
along.

RFC-058 ships the two pieces (1) and (2) need in isolation. Scoping it
this way means (a) the project edit sheet can save a connection string
today, (b) the sealed-input primitive is unit-tested and ready for
RFC-059 to consume without redesign.

## Non-goals

- The `sql_execute` tool itself — deferred to RFC-059.
- Any agent-callable version of the sealed-input primitive. Today the
  only caller is the host-side project edit sheet route, which doesn't
  involve the agent. RFC-059 will add the agent-triggered path.
- Keychain / libsecret encryption-at-rest. The secret lands next to
  `profile.env` API keys in the config JSON (0600). Encrypted storage is
  a fast-follow.
- Non-Supabase providers; multiple databases per project; read-only
  roles. One slot per project; UI calls it "Supabase" even though it's
  really any Postgres URL.
- iOS / Linux client UI. Mac first; the two others fast-follow once the
  schema is proven in use.

## Fix

### Data model (`host/src/types.ts`)

```ts
export interface ProjectDatabase {
  provider: "supabase";
  /** Pointer into HostConfigFile.projectSecrets; opaque to the client. */
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

export interface HostConfigFile {
  // …existing fields
  projectSecrets?: Record<string, Record<string, string>>;
}
```

`projectSecrets` sits at the top of the config file alongside
`projects`. No route serializes it. `ProjectInfo.database` carries only
non-sensitive metadata and ships normally.

### Secret store (`host/src/project-secrets.ts`)

One module owns every write and read:

```ts
get(config, projectId, slot) : string | undefined
set(config, projectId, slot, value) : void
remove(config, projectId, slot) : boolean
removeAllForProject(config, projectId) : void
DATABASE_CONNECTION_SLOT = "project.database_connection"
```

Keeps the surface area for future audit/encryption work to one file.

### Project database routes (`host/src/server.ts`)

- `POST /projects/:id/database` — body `{ connectionString, hostHint? }`.
  Writes the connection string via `project-secrets.set`, attaches a
  `database` block to the project with `addedAt`/`updatedAt`, saves the
  config. Response is the public `ProjectInfo` (secret never echoed).
- `DELETE /projects/:id/database` — removes the slot and the `database`
  block. Response: `{ ok: true }`.
- Validation: `connectionString` must be non-empty and start with
  `postgres://` or `postgresql://`. Error messages do **not** include
  the supplied value.
- The existing project DELETE route gains a `removeAllForProject` call
  so secrets don't outlive the project they belong to.

### Sealed-input primitive (`host/src/sealed-input.ts`)

Parallel side-channel to approvals and questions. `resolveApproval` is
150 lines across five branches (live Grok, Claude hook, bot loop,
orphaned, exit-plan); grafting a secret-carrying body onto it is the
kind of blast radius this RFC exists to avoid. Instead the primitive is
a standalone manager that mirrors `PendingQuestion`:

- `PendingSecretRequest { id, sessionId, projectId, slot, purpose, hint,
  createdAt, expiresAt? }`
- New `SessionEventType`s `secret.needed` / `secret.resolved`. Payloads
  carry slot metadata only — never the value.
- `SealedInputManager.request()` returns a promise the caller awaits.
- `submit(id, value)` writes via an injected `writeSecret` callback
  (bound to `project-secrets.set`), resolves the promise with `{ ok:
  true, slot }`.
- `cancel(id)` and TTL expiry resolve with `{ ok: false }`.
- Unused in production until RFC-059's `sql_execute` imports it. Still
  worth shipping now: it has nine passing vitest cases, no live caller
  cost, and the API-key fast-follow is already lined up to consume it.

### Mac client (deferred)

Wiring the "Database" section into the project edit sheet is a fast-follow
on this branch once the routes are proven in a REST client. iOS +
Linux follow Mac.

## Testing

- [x] `project-secrets.test.ts` — set/get/remove, project-level isolation,
      bucket cleanup, project shape never serializes the value (9/9).
- [x] `sealed-input.test.ts` — request/submit/cancel/expire paths, no
      value in event payloads, cancelForSession, listForSession (8/8).
- [ ] `project-database-route.test.ts` — POST/DELETE routes, bad input
      rejection without body echo, PROJECT delete removes secrets too.
- [ ] Manual soak: `curl POST /projects/clankerspanker/database` with a
      conn string; confirm config.json has the value, GET /projects
      doesn't echo it, DELETE clears both the project.database block and
      the secret slot.

## Rollout

1. `make check`.
2. `npm run build`; kill port-8787 PID so LaunchAgent reloads.
3. Smoke the two new routes with curl.
4. Update `docs/rfcs/README.md` row to **Shipped** once routes are in
   use (today or when RFC-059 lands against them).

## Follow-ups

- **RFC-059** (next, after backend parity progresses): `sql_execute` as
  a stdio MCP server auto-wired per profile; agent-callable sealed-input
  tool kind; approval card SQL preview; iOS + Linux parity.
- Mac project-edit-sheet "Database" section (lightweight once routes
  exist).
- Keychain / libsecret-backed slots.
- API-key slots using the same primitive.
- SSH tunnel / bastion support for private databases.
- Multi-host secret sync.
