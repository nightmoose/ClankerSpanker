import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TombstoneFile } from "./tombstones.js";

describe("TombstoneFile (RFC-051)", () => {
  it("reads the existing object format and the older string format", () => {
    const d = mkdtempSync(join(tmpdir(), "tomb-"));
    writeFileSync(join(d, "a.json"), JSON.stringify([{ grokSessionId: "g1", deletedAt: "x" }]));
    writeFileSync(join(d, "b.json"), JSON.stringify(["c1", "c2"]));
    expect(new TombstoneFile(join(d, "a.json"), "grokSessionId").has("g1")).toBe(true);
    const b = new TombstoneFile(join(d, "b.json"), "claudeSessionId");
    expect(b.has("c2")).toBe(true);
    expect(b.has("nope")).toBe(false);
    expect(b.has(undefined)).toBe(false);
  });

  it("writes the same format as before and survives a reload", () => {
    const d = mkdtempSync(join(tmpdir(), "tomb-"));
    const p = join(d, "deleted-agy-sessions.json");
    const t = new TombstoneFile(p, "conversationId");
    t.add("a1");
    t.add("a1");
    t.add("a2");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    expect(raw.map((e: { conversationId: string }) => e.conversationId)).toEqual(["a1", "a2"]);
    expect(typeof raw[0].deletedAt).toBe("string");
    expect(new TombstoneFile(p, "conversationId").has("a2")).toBe(true);
  });

  it("tolerates a missing or corrupt file", () => {
    const d = mkdtempSync(join(tmpdir(), "tomb-"));
    writeFileSync(join(d, "bad.json"), "{not json");
    expect(new TombstoneFile(join(d, "bad.json"), "k").has("x")).toBe(false);
    expect(new TombstoneFile(join(d, "missing.json"), "k").has("x")).toBe(false);
  });
});
