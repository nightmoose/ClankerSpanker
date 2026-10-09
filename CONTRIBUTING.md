# Contributing to ClankerSpanker

Thanks for helping out! By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are licensed under the project's [MIT license](LICENSE).

## Ground rules

- One issue / topic per branch and PR.
- Never break existing dispatch, approval or auth behavior.
  `host/src/auth.ts` is the security boundary: an empty token means nobody gets in.
- One host gateway; clients are thin. Client ownership: [`docs/CLIENTS.md`](docs/CLIENTS.md).
- No tokens, `.env` files, keys or personal hostnames/IPs in commits.
  Do not add new hardcoded LAN IPs (clients pair by QR over Tailscale).

## RFC-first for non-trivial work

```bash
make rfc SLUG=short-kebab      # allocates the next number from docs/rfcs/_template.md
```

List the RFC in [`docs/rfcs/README.md`](docs/rfcs/README.md). Typos and obvious one-liners can skip an RFC.

## Before you open a PR

- [ ] `make check` is green (RFC filename/uniqueness check, untested-module check, test-count ratchet, typecheck, build)
- [ ] New host behavior has a vitest (or a row in [`docs/TEST-EXCEPTIONS.md`](docs/TEST-EXCEPTIONS.md) with a reason)
- [ ] User-facing HTTP/CLI/config/UI changes: docs updated, and `shared/openapi.yaml` if routes changed
- [ ] iOS client changes: tested on a physical device where relevant (not simulator-only)

## Tests

```bash
make check          # repo checks + host typecheck + build (runs npm test)
cd host && npm test
```

The test count is ratcheted in `host/test-baseline.txt`; do not delete tests to go green.

## Security

Report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).
