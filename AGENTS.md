# Read this first

**Check your saved memory before starting** — look for `estate-four-repo-map`,
`estate-open-work` and `estate-sandbox-git-limits`. Then read
`~/mercenary/STATUS-2026-08-23.md` (estate-wide) and
[`PROJECT_STATUS.md`](./PROJECT_STATUS.md) (this repo). Day-to-day play:
[`docs/NEXT-STEPS.md`](docs/NEXT-STEPS.md). `STATUS-2026-07-30.md` is historical.

## Orientation — the naming is a mess, and that is the first trap

This project was renamed **GrokDispatch → ClankerSpanker** and the rename is
**incomplete**. Every one of these is currently true:

| Thing | Name |
|---|---|
| Repo / remote | `ClankerSpanker` |
| Enclosing directory | `~/Projects/GrokDispatch` |
| iOS app directory | `ios/GrokDispatch/GrokDispatch/` (old name, twice) |
| Xcode project | `ClankerSpanker.xcodeproj` (current) |
| Stale leftovers | `GrokDispatch.xcodeproj`, `GrokDispatch.xcodeproj.bak` |
| Bundle id | `com.nightmoose.clankerspanker` |
| Wire header | `x-grok-dispatch-token` |

**The repo root is here, not `ios/`.** Opening only `ios/GrokDispatch` hides both
the `host/` component and `.git` — that mistake was made once already and led to
"this project has no repo".

## Layout

```
host/     Node + TypeScript gateway, port 8787  ← the testable part
desktop/  Electron — Linux laptop command center only
ios/      SwiftUI — phone + Mac native (Mac is the macOS laptop shell)
shared/   openapi.yaml
docs/CLIENTS.md   ← client ownership (read before adding another desktop UI)
```

Port `8787` is deliberately distinct from Bricklayer's `8791` so both daemons
can run on the same Mac. They are **separate products** that happen to share a
shape: local host, bearer token, phone client.

**Laptop clients:** Mac = native (`ios/`, scheme ClankerSpanker → My Mac).  
Linux = Electron (`desktop/`). Do not dual-maintain full session UIs on Mac.

## Rules

- **`host/src/auth.ts` is the security boundary.** Token comparison is
  constant-time (`timingSafeEqual`, guarding length first — it throws on
  mismatched lengths). An empty configured token must authorise nobody.
  Covered by `host/src/auth.test.ts`.
- **Don't rename `x-grok-dispatch-token` casually.** It breaks every client
  already holding a token. That needs a deliberate migration, not a tidy-up.
- **Don't hardcode network addresses.** `ConnectionDefaults` still ships
  `http://192.168.50.9:8787`; that is a known defect, not a pattern to follow.
- Tests are excluded from the build (`tsconfig` `exclude`) so `dist/` stays
  clean — keep it that way.

## House style (ContractGate loop)

Non-trivial work is RFC-first. Playbook: [`docs/HOUSE-STYLE.md`](docs/HOUSE-STYLE.md).
Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Ledger: [`docs/STATUS.md`](docs/STATUS.md).

```bash
make check                 # house-style-check + host tests + typecheck + build
make rfc SLUG=short-kebab  # next RFC number + template
```

CI runs `make check` on every push/PR to `main`. Do not land heavy changes
without an RFC and a `MAINTENANCE_LOG.md` line.

## Gates

```bash
make check
cd host && npm test        # vitest — ratcheted in host/test-baseline.txt (106 as of RFC-000)
cd host && npm run typecheck
cd host && npm run build
```

The iOS app has **no tests**. Xcode projects come from **xcodegen** via
`ios/GrokDispatch/project.yml`; the `.xcodeproj` is a build artifact.
