# Rules for coding agents (Cursor, Claude, Grok, anyone else)

Read this before you touch the repo. These are not suggestions. A PR that breaks
any rule below gets closed without review, no matter how good the code is.

## Why this file exists

On 2026-10-19 this repo had **three different RFC-058s at the same time**:

| Branch | What it called RFC-058 |
|---|---|
| `nightly-maintenance-2026-10-02-rfc058-inline-exec` (pushed 2026-10-07) | Inline shell execution |
| `nightly-maintenance-2026-10-13-rfc058-project-sql` (local, never pushed) | Per-project SQL. It also claimed RFC-059, which the inline-exec branch already used for host self-update |
| `cursor/rfc-058-hosted-web-61b2` (merged 2026-10-19) | The hosted product site |

A Cursor agent took 058 even though a pushed branch had owned it for twelve days.
The agent looked only at its own checkout of `main`. A human then spent a
session renumbering, rebasing, and fixing code comments in three branches.
Do not cause that again.

## 1. RFC numbers are global across every branch

A number is taken if it appears **anywhere**: `main`, any `origin/*` branch, any
open PR, or a "RFC-NNN will…" promise inside another RFC. Your checkout of `main`
is not the whole picture. Sixty-plus RFCs exist, and some live in a private
repo, so gaps are not free numbers.

**Do this, every time:**

```bash
git fetch --prune origin
make rfc SLUG=short-kebab      # scans every local and origin/* branch, then picks the next free number
```

**Never:**

- Choose a number yourself, or by looking at `docs/rfcs/` on `main`.
- Reuse a number because "that branch isn't merged yet." Unmerged branches still own their numbers.
- Write "RFC-NNN will do X" for a future RFC unless you allocate that number now with
  `make rfc` and commit the stub in the same change.
- Renumber someone else's RFC to make room for yours. Yours moves, not theirs.

`scripts/house-style-check.py` (CI and `make check`) now fails any branch that adds an
RFC file whose number another `origin/*` branch uses for a different file. Do not
get around the check. Do not edit it to go green.

## 2. Start from current `main`

- Run `git fetch origin` and branch from `origin/main` at the moment you start work.
  Do not branch from a stale local `main`.
- If `main` moves while your PR is open, rebase onto it and rerun `make check` before asking for review.

## 3. `make check` is green before you push, not after

- Run `make check` locally. It covers the RFC index, unique numbers, the untested-module rule,
  the test-count ratchet, typecheck, and build.
- Every new `host/src/**/*.ts` module ships with a sibling `*.test.ts`. "I'll add tests later" is not allowed.
  (The project-SQL branch added `host/src/mcp/sql-execute.ts` with no test, and CI fails on it.)
- `host/test-baseline.txt` only goes up. Set it to the real count `npm test` prints. Never lower it.

## 4. One RFC, one branch, one PR

- Name the branch after the RFC: `rfc-NNN-slug`, or the nightly form
  `nightly-maintenance-YYYY-MM-DD-rfcNNN-slug`. The number in the branch name must
  match the RFC file.
- Do not hide a second RFC in a branch named for the first. If the work needs two RFCs,
  open two branches.
- Add a row for your RFC to `docs/rfcs/README.md` in the same commit that adds the RFC.

## 5. Things you never do without the owner saying so in writing

- Merge your own PR.
- Force-push `main`, or any branch you did not create.
- Change `host/src/auth.ts`, CORS, token handling, or anything else that decides who
  can reach the gateway, unless an RFC calls for that change.
- Commit tokens, `.env` files, keys, personal hostnames, or LAN IPs.
- Deploy, change DNS, or change Vercel project settings.

## 6. Your PR description must say

- Which RFC number you used, and that `make rfc` gave it to you after `git fetch`.
- The output of `make check`. Paste it; don't summarize it.
- Anything you did not test, such as iOS on a device or the Mac app. Say so plainly.

If any of this is unclear, stop and ask in the PR. Do not guess.
