# ClankerSpanker

**Read first:** [`docs/HOUSE-STYLE.md`](docs/HOUSE-STYLE.md), then [`AGENTS.md`](AGENTS.md).

ContractGate process, enforced here: RFC-first, one issue per
`nightly-maintenance-YYYY-MM-DD-rfcNNN-slug` branch, tests, docs in the same
change, `MAINTENANCE_LOG.md` + `docs/STATUS.md`, `make check` before merge.

## Commands

```
make check
cd host && npm test && npm run typecheck && npm run build
make rfc SLUG=short-kebab
```

## Load-bearing

- `host/src/auth.ts` — empty token authorises nobody
- One host gateway (`docs/CLIENTS.md`)
- Do not rename `x-grok-dispatch-token` casually
- Do not copy `ConnectionDefaults.lanHostURL` (`192.168.50.9`)
