# Nightmoose house style

Lifted from **ContractGate** — the strictest process we have actually run.
ClankerSpanker is the first repo that **enforces** it. Other Nightmoose repos
should follow the same loop even before their CI catches up.

Agents: read this before writing code. Humans: same.

## Why this exists

Uncommitted, unreviewed, untested piles are how we lost the plot. ContractGate
did not: every non-trivial change had an RFC, a named branch, tests, a doc
update, a log line, and a CI gate that could fail the merge.

## The loop (non-negotiable)

```
1. Fetch origin/main. Branch. One issue.
2. If it is not a typo/one-liner: write or update an RFC first.
3. Implement only what the RFC says. Out of scope → follow-up RFC, not silent extras.
4. Tests for new behavior. Do not skip, ignore, or delete tests to go green.
5. User-facing change → update the matching docs page (or add one).
6. Append MAINTENANCE_LOG.md. Update docs/STATUS.md if you added/landed an RFC.
7. make check. Then PR (or merge only if check is green).
```

## RFC-first

Anything beyond a small bug fix starts in `docs/rfcs/`.

```
docs/rfcs/NNN-short-slug.md
```

Use [`_template.md`](_template.md). Required headers: **Status**, **Date**,
**Branch**, **Problem**, **Fix**, **Testing**, **Rollout**.

| Status | Meaning |
|---|---|
| Draft | Design under review — do not implement beyond a spike |
| Accepted | Signed off; implement inside this RFC only |
| Shipped | On `main` |
| Superseded | Replaced by a later RFC |

`scripts/new-rfc.sh <slug>` allocates the next number.

Trivial (typo, comment, obvious one-liner, status-file-only) may skip an RFC.
If `make check` says you needed one, you needed one.

## Branching

```
nightly-maintenance-YYYY-MM-DD-rfcNNN-short-slug
```

Example: `nightly-maintenance-2026-08-23-rfc000-house-style`.

Branch from **fetched** `origin/main`. One issue per branch. Do not pile a
second feature onto a red PR.

## Tests

- New behavior needs a test, especially auth, session, approval, and dispatch paths.
- Host: `cd host && npm test` (vitest). Typecheck + build must stay clean.
- A test-count **ratchet** fails CI if the suite shrinks (ContractGate RFC-071
  analog). Raise the baseline when you add tests; never lower it to land a PR.
- Do not mark a test skipped to make CI pass. If it needs a live host, gate it
  and document why.
- Swift: `make test-swift` (RFC-046) runs the `ClankerSpankerMacTests` bundle
  (hosted by the Mac app). Pure logic you add or change in the Swift clients
  gets a test there. CI is Linux, so run it locally before merging Swift work.

## Docs with the code

User-facing = any HTTP path, CLI/flag, config key, client screen, or wire header
a person can read or write.

1. Update the existing `docs/` page if one covers that surface.
2. Otherwise add `docs/<feature>.md` (or a reference page).
3. Keep `shared/openapi.yaml` in the same change when you add/change host routes. `openapi-contract.test.ts` (RFC-044) fails the build if you forget.

## Log

`MAINTENANCE_LOG.md` is the run record (newest at top). `docs/STATUS.md` is the
RFC ledger. `PROJECT_STATUS.md` is the snapshot a stranger reads first.

A shipped RFC that is missing from `docs/STATUS.md` is unfinished.

## Security / load-bearing

Do not “clean up” these without an RFC and a regression test:

- Host token auth (`host/src/auth.ts`) — empty token authorises nobody; comparison stays constant-time.
- Wire header `x-grok-dispatch-token` (legacy) and `Authorization: Bearer`.
- One host gateway. Do not add a second. Client ownership: `docs/CLIENTS.md`.
- No secrets in git. No hardcoded LAN IPs in clients — pair by QR, connect
  over Tailscale (RFC-026/028/043).

## Chat / agent manner

Result first. One issue at a time. No drive-by refactors. Do not rewrite the
rename leftovers (`GrokDispatch` paths) unless that *is* the RFC.

iOS client work is not done until it is installed on **Deez Nutz**
(scheme `ClankerSpankerPhone`). See [`CLIENTS.md`](CLIENTS.md) § Phone deploy.
Host changes that affect a running gateway need a LaunchAgent kick so
`host/dist` loads. Phone badges when killed need APNs ([`APNS.md`](APNS.md)).

## Local + CI gate

```bash
make check    # house-style-check + host test + typecheck + build
```

CI runs the same on every push/PR to `main`. Docs-only changes skip the host
matrix but still run the house-style file/index checks.

## Copying this to another repo

Minimum install:

1. This file (or a pointer to it).
2. `docs/rfcs/_template.md` + `docs/STATUS.md` + `MAINTENANCE_LOG.md`.
3. `scripts/house-style-check.py` + `scripts/new-rfc.sh` (adapt `HEAVY_PREFIXES`).
4. A `make check` that runs *this repo’s* tests.
5. `.github/workflows/ci.yml` that fails the merge on a red check.
