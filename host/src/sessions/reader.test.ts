import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgySessions } from "./reader.js";

describe("listAgySessions", () => {
  it("returns empty when the CLI dir is missing", () => {
    expect(listAgySessions(10, join(tmpdir(), "no-agy-cli-here"))).toEqual([]);
  });

  it("reads metadata titles, workspace cwd, and last_conversations fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-cli-"));
    const cwd = mkdtempSync(join(tmpdir(), "agy-ws-"));
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "conversations"), { recursive: true });
    const idMeta = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const idLast = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeFileSync(
      join(root, "cache", "conversation_metadata.json"),
      JSON.stringify({
        conversations: {
          [idMeta]: {
            summary: {
              ID: idMeta,
              Title: "Fix the login form",
              Preview: "ignored when title is set",
              UpdatedAt: "2026-08-20T21:34:20.556224Z",
              WorkspaceURIs: [`file://${cwd}`],
            },
          },
        },
      }),
    );
    writeFileSync(
      join(root, "cache", "last_conversations.json"),
      JSON.stringify({ [cwd]: idLast }),
    );
    writeFileSync(join(root, "conversations", `${idLast}.db`), "sqlite-stub");
    const listed = listAgySessions(20, root);
    expect(listed.map((s) => s.id).sort()).toEqual([idLast, idMeta].sort());
    const meta = listed.find((s) => s.id === idMeta)!;
    expect(meta.source).toBe("antigravity");
    expect(meta.title).toBe("Fix the login form");
    expect(meta.cwd).toBe(cwd);
    const last = listed.find((s) => s.id === idLast)!;
    expect(last.cwd).toBe(cwd);
    expect(last.title).toMatch(/^Gemini /);
  });
});
