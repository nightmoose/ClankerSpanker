import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGrokHelperCwd,
  isGrokHelperSession,
  listAgySessions,
  listDiskSessions,
} from "./reader.js";

describe("isGrokHelperCwd / isGrokHelperSession", () => {
  it("detects subagent worktree paths and URL-encoded group dirs", () => {
    expect(
      isGrokHelperCwd(
        "/Users/me/.grok/worktrees/repo/subagent-01a0692c-baff-7701-b649-7bac996a8d97",
      ),
    ).toBe(true);
    expect(
      isGrokHelperCwd(
        "%2FUsers%2Fme%2F.grok%2Fworktrees%2Frepo%2Fsubagent-01a0692c-baff-7701-b649-7bac996a8d97",
      ),
    ).toBe(true);
    expect(isGrokHelperCwd("/Users/me/Projects/GrokDispatch")).toBe(false);
    expect(isGrokHelperCwd("/Users/me/.grok/worktrees/alexsuarez-nightmoosedirtwork")).toBe(
      false,
    );
  });

  it("treats session_kind subagent* and worktree_label as helpers", () => {
    expect(isGrokHelperSession({ sessionKind: "subagent" })).toBe(true);
    expect(isGrokHelperSession({ sessionKind: "subagent_resume" })).toBe(true);
    expect(isGrokHelperSession({ worktreeLabel: "subagent-01a0692c" })).toBe(true);
    expect(
      isGrokHelperSession({
        cwd: "/Users/me/Projects/Foo",
        sessionKind: undefined,
        worktreeLabel: undefined,
      }),
    ).toBe(false);
  });
});

describe("listDiskSessions", () => {
  it("returns user Grok sessions and skips subagent helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-sess-"));
    const userGroup = "%2FUsers%2Fme%2FProjects%2FFoo";
    const helperGroup =
      "%2FUsers%2Fme%2F.grok%2Fworktrees%2Frepo%2Fsubagent-01a0692c-baff-7701-b649-7bac996a8d97";
    const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const helperId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const kindHelperId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mkdirSync(join(root, userGroup, userId), { recursive: true });
    mkdirSync(join(root, helperGroup, helperId), { recursive: true });
    mkdirSync(join(root, userGroup, kindHelperId), { recursive: true });
    writeFileSync(
      join(root, userGroup, userId, "summary.json"),
      JSON.stringify({
        info: { session_id: userId, cwd: "/Users/me/Projects/Foo" },
        generated_title: "Ship the login fix",
        updated_at: "2026-09-09T12:00:00.000Z",
        current_model_id: "grok-build",
      }),
    );
    writeFileSync(
      join(root, helperGroup, helperId, "summary.json"),
      JSON.stringify({
        info: {
          session_id: helperId,
          cwd: "/Users/me/.grok/worktrees/repo/subagent-01a0692c-baff-7701-b649-7bac996a8d97",
        },
        generated_title: "PR review helper",
        session_kind: "subagent",
        worktree_label: "subagent-01a0692c-baff-7701-b649-7bac996a8d97",
        updated_at: "2026-09-09T12:01:00.000Z",
      }),
    );
    writeFileSync(
      join(root, userGroup, kindHelperId, "summary.json"),
      JSON.stringify({
        info: { session_id: kindHelperId, cwd: "/Users/me/Projects/Foo" },
        generated_title: "Nested helper still in project cwd",
        session_kind: "subagent_resume",
        updated_at: "2026-09-09T12:02:00.000Z",
      }),
    );
    const listed = listDiskSessions(20, root);
    expect(listed.map((s) => s.id)).toEqual([userId]);
    expect(listed[0]?.title).toBe("Ship the login fix");
    expect(listed[0]?.cwd).toBe("/Users/me/Projects/Foo");
  });
});

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
