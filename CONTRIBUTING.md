# Contributing to ClankerSpanker

Process is **ContractGate’s**, adapted to this repo. Full playbook:
[`docs/HOUSE-STYLE.md`](docs/HOUSE-STYLE.md).

## Ground rules

- One issue per branch. Do not silently add extras.
- Never break existing dispatch / approval / auth behavior.
- `host/src/auth.ts` is the security boundary. Empty token ⇒ nobody.
- One host gateway. Client ownership: [`docs/CLIENTS.md`](docs/CLIENTS.md).

## RFC-first

Non-trivial work starts with an RFC:

```bash
make rfc SLUG=short-kebab
git checkout -b nightly-maintenance-$(date +%F)-rfcNNN-short-kebab
```

Template: [`docs/rfcs/_template.md`](docs/rfcs/_template.md).
Ledger: [`docs/STATUS.md`](docs/STATUS.md).

Typos and obvious one-liners can skip an RFC. If `make check` disagrees, write
the RFC.

## Before you open a PR (or push `main`)

- [ ] `make check` is green
- [ ] New host behavior has a vitest (or an RFC + `docs/TEST-EXCEPTIONS.md` row)
- [ ] User-facing HTTP/CLI/config/UI: docs updated; OpenAPI if routes changed
- [ ] `MAINTENANCE_LOG.md` appended
- [ ] RFC + `docs/STATUS.md` updated

## Tests

```bash
make check          # house style + host typecheck + build (includes npm test)
cd host && npm test
```

Test count is ratcheted in `host/test-baseline.txt`. Do not delete tests to
pass CI.

## Security

No tokens, `.env`, or `Secrets.plist` in git. Do not add new hardcoded LAN IPs.
The existing `ConnectionDefaults.lanHostURL` is a known defect.
