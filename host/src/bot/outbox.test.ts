import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listOutbox } from "./outbox.js";

describe("listOutbox", () => {
  it("returns newest markdown drafts and ignores gitignore", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-outbox-"));
    mkdirSync(join(cwd, ".bot-outbox"));
    writeFileSync(join(cwd, ".bot-outbox", ".gitignore"), "*\n");
    writeFileSync(join(cwd, ".bot-outbox", "a.md"), "first");
    writeFileSync(join(cwd, ".bot-outbox", "b.md"), "second");
    const items = listOutbox(cwd);
    expect(items.map((i) => i.filename).sort()).toEqual(["a.md", "b.md"]);
    expect(items.every((i) => i.content.length > 0)).toBe(true);
  });

  it("returns empty when the outbox is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-outbox-"));
    expect(listOutbox(cwd)).toEqual([]);
  });
});
