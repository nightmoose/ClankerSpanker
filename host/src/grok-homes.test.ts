import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { knownGrokHomes, listGrokHomeSessions } from "./grok-home.js";
import type { AgentProfile } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function session(home: string, cwd: string, id: string, updatedAt: string, title = id) {
  const dir = join(home, "sessions", encodeURIComponent(cwd), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { session_id: id, cwd }, generated_title: title, updated_at: updatedAt }));
}

describe("knownGrokHomes (RFC-048)", () => {
  it("lists the machine home plus each Grok/bot profile's home, once each", () => {
    const saved = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    const profiles = [
      { id: "nightmoose", name: "NightMoose", backend: "grok" },
      { id: "personal", name: "Personal", backend: "claude" },
      { id: "shared", name: "Shared", backend: "grok", grokHome: join(homedir(), ".grok") },
    ] as AgentProfile[];
    const homes = knownGrokHomes(profiles, "/data");
    if (saved) process.env.GROK_HOME = saved;
    expect(homes.map((h) => h.label)).toEqual(["~/.grok", "NightMoose home"]);
    expect(homes[1]).toMatchObject({ home: "/data/grok-homes/nightmoose", profileId: "nightmoose" });
  });
});

describe("listGrokHomeSessions (RFC-048)", () => {
  it("imports from every home, tags the source, newest wins on id", () => {
    const a = mkdtempSync(join(tmpdir(), "grok-a-"));
    const b = mkdtempSync(join(tmpdir(), "grok-b-"));
    dirs.push(a, b);
    session(a, "/Users/x/Projects/App", "s1", "2026-09-20T00:00:00Z");
    session(b, "/Users/x/contractgate", "s2", "2026-09-24T00:00:00Z");
    session(b, "/Users/x/Projects/App", "s1", "2026-09-25T00:00:00Z", "newer copy");
    const hints = listGrokHomeSessions([
      { home: a, label: "~/.grok" },
      { home: b, label: "NightMoose home", profileId: "nightmoose" },
    ]);
    expect(hints.map((h) => h.id)).toEqual(["s1", "s2"]);
    expect(hints[0]).toMatchObject({ title: "newer copy", grokHome: b, grokHomeLabel: "NightMoose home", profileId: "nightmoose" });
    expect(hints[1]).toMatchObject({ grokHome: b });
  });
});
