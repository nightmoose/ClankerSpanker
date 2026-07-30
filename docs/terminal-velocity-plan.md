# Plan: Play Terminal Velocity now + kid-friendly trainer

> **Readable copies (same content):**
> - `~/Projects/GrokDispatch/docs/terminal-velocity-plan.md`
> - `~/Desktop/terminal-velocity-plan.md`
>
> Grok also keeps a session copy under `~/.grok/sessions/…/plan.md` for the Plan tab UI — that path is awkward; use the copies above.

## Goals (confirmed)

1. **Play the real game now** — concrete steps for you on macOS.
2. **Build a more forgiving version** — a spiritual successor trainer for your son (easier flight, gentler combat, clear goals).

**Workspace note:** GrokDispatch / ClankerSpanker is an AI dispatch app, not a game. The trainer will live in a **new sibling project** so we don’t touch host/iOS production code.

---

## Part 1 — How to play the real game *now*

### Fastest free path (tonight, zero purchase)

**Browser play (easiest):**

1. Open [DOS Games Archive — Terminal Velocity](https://www.dosgamesarchive.com/download/terminal-velocity).
2. Click **“Play DOS game online”** (Chrome recommended).
3. Fullscreen + browser zoom at **100%** so the canvas isn’t cropped.
4. Episode 1 shareware only (~9 levels) — enough to rediscover the feel.

**Local shareware on this Mac (better keyboard/mouse):**

```bash
# Install DOSBox
brew install dosbox
# or: brew install dosbox-x

# Download shareware ZIP from:
# https://www.dosgamesarchive.com/download/terminal-velocity
# (tv-box.zip or 3dtv12.zip)

# Extract, then:
cd /path/to/extracted/tv
dosbox .
# Inside DOSBox:
#   cd TV   (or whatever the game folder is)
#   TV.EXE  (or TVWEB.BAT / RUN.BAT depending on package)
```

**DOSBox tips for Terminal Velocity:**

- Cycles: start around `cycles=12000`–`20000` (audio logo stutter often fixed near 11k–12k; gameplay may want higher).
- If too slow/fast: `Ctrl-F11` / `Ctrl-F12` (or edit `~/Library/Preferences/DOSBox Preferences`).
- Lower detail in-game if frame rate tanks.
- Mouse may need capture: click into the window; release with `Ctrl-F10` (classic DOSBox).

**Classic cheats (type during play, for you — not for the kid trainer):**

| Code | Effect |
|------|--------|
| `trigods` | God mode toggle |
| `trishld` | Full shields |
| `trinext` | Next level |
| `maniacs` | Afterburner |
| `trifir#` | Give weapon `#` |

### Full game (recommended purchase)

| Store | Link | Notes |
|-------|------|--------|
| **GOG** | [Terminal Velocity: Boosted Edition](https://www.gog.com/en/game/terminal_velocity_boosted_edition) | DRM-free; often includes **legacy DOS** + Boosted — best for Mac users who want pure DOS via DOSBox |
| **Steam** | [Boosted Edition](https://store.steampowered.com/app/1956430/Terminal_Velocity_Boosted_Edition/) | Windows native remaster packaging |

**Price:** roughly $6–12 (sales common).

**On macOS specifically:**

| Option | Effort | Recommendation |
|--------|--------|----------------|
| GOG legacy DOS + DOSBox | Low–medium | **Best native Mac path** if you buy GOG |
| Browser shareware | Lowest | Try tonight before buying |
| Boosted Edition (Windows) | Needs Windows layer | Parallels / VMware / Boot Camp / Crossover; gamepad-friendly |
| Mobile (2015 ports) | Check App Store / Play Store | Older ports; availability varies by region |

**What Boosted Edition improves:** longer draw distance, widescreen framing, modern controller defaults, native Windows speed. **What it is not:** full HD remaster (still low internal res). Some players still prefer DOS for mouse feel and multi-slot saves — GOG’s dual package covers both.

### Fan engine (optional later)

[Terminal Recall](https://github.com/jtrfp/terminal-recall) — Java OpenGL remake; needs **legally owned** `.POD` files from a purchase. Not required for tonight.

---

## Part 2 — Kid-friendly trainer to build

### Concept

**Working title:** *Flight School: Ares Cadet* (or similar — **not** “Terminal Velocity”).

A **browser game** inspired by TV’s outdoor flight combat, tuned for a child learning to fly and shoot:

| Original TV | Cadet trainer (forgiving) |
|-------------|---------------------------|
| Fast, punishing, easy to crash | Slower default speed; soft terrain bounce |
| Afterburner disables fire | Afterburner optional / still allows weak fire |
| Dense enemy fire, shield drain | Sparse enemies; big hitboxes; slow bullets |
| Cryptic 90s UI | Huge HUD: objectives, arrows, “fly here” |
| Keyboard + mouse mastery | Simple keys + optional “easy aim” assist |
| Instant fail pressure | Generous shields; no fail on first crash; checkpoints |

### Audience assumptions (defaults; adjustable)

- Child learning mouse + WASD / arrows.
- Session length: **5–10 minutes** per mission.
- Parent can toggle **difficulty** (Cadet / Pilot / Ace) so you can play harder later.

### MVP feature set

1. **Flight school hub** — title screen → pick mission 1–3.
2. **Mission 1 — Fly:** Navigate rings / checkpoints over gentle hills (no shooting).
3. **Mission 2 — Shoot:** Destroy ground towers (stationary); aim assist on.
4. **Mission 3 — Dogfight lite:** 2–3 slow enemy drones; win by clearing them + extract beacon.
5. **Always-on helpers:**
   - Yellow **objective arrow** (3D or HUD).
   - **Auto-level** hold (optional toggle — reduces roll chaos).
   - **Aim assist** (projectiles bias toward nearest target in cone).
   - **Shield regen** after a few seconds without hits.
   - **Soft crash:** bounce up + small shield loss, not instant death.
6. **Win/lose:** Lose only if shields empty; respawn at last checkpoint with full shields (Cadet mode).

### Tech stack

| Piece | Choice |
|-------|--------|
| Project | New dir: `~/Projects/ares-cadet/` (sibling to GrokDispatch) |
| Tooling | Vite + TypeScript |
| 3D | Three.js |
| Input | Keyboard + mouse (pointer lock); gamepad optional later |
| Deploy | `npm run dev` locally; static build for any static host |
| Assets | Procedural (geometry + simple colors/noise) — no TV IP |

### Architecture

```
ares-cadet/
  package.json
  index.html
  src/
    main.ts                 # boot, game loop
    styles.css
    input/controls.ts
    ship/playerShip.ts      # forgiving physics
    world/terrain.ts        # heightmap
    world/rings.ts          # flight school rings
    combat/projectiles.ts
    combat/enemies.ts
    combat/aimAssist.ts
    mission/missions.ts     # mission 1–3 definitions
    mission/objectives.ts
    ui/hud.ts               # big text, arrows, difficulty
    ui/menu.ts
    audio/sfx.ts            # optional simple WebAudio beeps
    config/difficulty.ts    # Cadet / Pilot / Ace tunables
```

### Difficulty table (tunables in one file)

| Param | Cadet | Pilot | Ace |
|-------|-------|-------|-----|
| Max speed | Low | Medium | TV-ish |
| Turn rate | High (responsive) | Medium | Medium |
| Enemy damage | Very low | Medium | High |
| Enemy fire rate | Rare | Moderate | Aggressive |
| Aim assist | Strong | Light | Off |
| Auto-level | On | Toggle | Off |
| Crash penalty | Bounce, tiny damage | Bounce, more damage | Harder |
| Respawn | Free at checkpoint | Limited | None |
| Shield regen | Fast | Slow | Off |

Default ship for son: **Cadet**.

### Implementation phases

| Phase | Deliverable | Est. |
|-------|-------------|------|
| **0** | Scaffold Vite/TS/Three; fly over flat colored plane | ~1 h |
| **1** | Heightmap + soft collision bounce + Cadet speed | ~2 h |
| **2** | Mission 1: fly through N rings; big objective markers; win screen | ~2 h |
| **3** | Shoot + aim assist; Mission 2 towers | ~2–3 h |
| **4** | Mission 3 drones + extract; difficulty menu; shield regen | ~2–3 h |
| **5** | Polish: menu, SFX, instructions panel for parent, fullscreen | ~1–2 h |

**Success criteria:** Your son can complete Mission 1 without help after a short explain; you can switch to Ace and feel closer to classic arcade flight.

### Explicit non-goals (MVP)

- Original Terminal Velocity maps, music, models, or names as product branding.
- Multiplayer / tunnels / full campaign.
- iOS App Store packaging (browser is enough; iPad Safari should work later with touch if we add it).
- Changes to ClankerSpanker.

### Parent UX

- On-screen **control card** before first flight:  
  `W/S` throttle · `A/D` roll or strafe · mouse look · `Space` fire · `Shift` boost · `Esc` menu  
  (exact bindings finalized in impl; prefer **arrow keys + mouse** alternative if easier for the child).
- Pause anytime; difficulty changeable from pause menu without restarting project.

---

## Delivery order after approval

1. **Immediately in chat:** Expand Part 1 into a short playbook you can follow (already in this plan).
2. **Implement Part 2:** Create `~/Projects/ares-cadet` (or name you prefer), phases 0→4 until Mission 1–3 playable on Cadet.
3. **Handoff:** `npm install && npm run dev` → open localhost; show your son Mission 1.

---

## Open preferences (sensible defaults if you don’t care)

| Question | Default we'll use |
|----------|-------------------|
| Project name / folder | `ares-cadet` under `~/Projects/` |
| Control scheme | Mouse look + WASD + Space fire (keyboard-only fallback) |
| Age tone | Friendly sci-fi, no gore; explosions = “pop” / sparks |
| Where to put code | Outside GrokDispatch |

---

## Key decisions

1. **Real game via buy/shareware** — no illegal full dumps in repo.
2. **Trainer is spiritual successor** — original art/audio, kid-first tuning.
3. **Browser + Three.js** — Mac-native, shareable with son via localhost.
4. **Separate project** — leave ClankerSpanker untouched.

---

## Approval

Approve this plan to:

1. Keep the **play-now** instructions above as the answer for the original game.
2. **Implement** the Cadet trainer (new project, phases 0–4).
