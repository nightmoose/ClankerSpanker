import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraDirsAgentNote, isPathAllowed, listSessionFiles, readSessionFile } from "./files.js";
import { normalizeExtraDirs } from "../config.js";
import type { DispatchSession, HostConfigFile } from "../types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cs-files-"));
}

function config(dataDir: string, projects: HostConfigFile["projects"] = []): HostConfigFile {
  return {
    hostToken: "t".repeat(32),
    bindHost: "127.0.0.1",
    bindPort: 8787,
    grokBinary: "grok",
    projects,
    allowCustomPaths: true,
    profiles: [],
    autoApproveKinds: [],
    notifyDesktop: false,
    dataDir,
  };
}

function session(cwd: string, extra?: Partial<DispatchSession>): DispatchSession {
  const ts = new Date().toISOString();
  return {
    id: "sess-files",
    backend: "claude",
    title: "t",
    prompt: "p",
    cwd,
    model: "claude",
    planMode: false,
    subagents: false,
    worktree: false,
    status: "idle",
    createdAt: ts,
    updatedAt: ts,
    transcript: [],
    toolCalls: [],
    events: [],
    ...extra,
  };
}

describe("normalizeExtraDirs", () => {
  it("skips cwd, blanks, and duplicates", () => {
    const cwd = tmp();
    const extra = tmp();
    const cfg = config(tmp());
    expect(normalizeExtraDirs(cfg, cwd, [extra, extra, cwd, ""])).toEqual([extra]);
  });

  it("throws on a missing extra folder", () => {
    const cwd = tmp();
    const cfg = config(tmp());
    expect(() => normalizeExtraDirs(cfg, cwd, ["/no/such/cs-extra-xyz"])).toThrow(/Invalid extra folder/);
  });

  it("rejects extra folders outside allowlisted projects when custom paths are off", () => {
    const cwd = tmp();
    const extra = tmp();
    const allowed = tmp();
    const cfg = config(tmp(), [{ id: "p", name: "p", path: allowed, paths: [allowed] }]);
    cfg.allowCustomPaths = false;
    expect(() => normalizeExtraDirs(cfg, cwd, [extra])).toThrow(/not allowlisted/);
  });
});

describe("extraDirsAgentNote", () => {
  it("is empty when there are no dirs", () => {
    expect(extraDirsAgentNote()).toBe("");
    expect(extraDirsAgentNote([])).toBe("");
  });

  it("lists unique dirs", () => {
    const note = extraDirsAgentNote(["/a", "/a", "/b"]);
    expect(note).toContain("- /a");
    expect(note).toContain("- /b");
    expect(note.startsWith("[Additional workspace folders")).toBe(true);
  });
});

describe("listSessionFiles / readSessionFile", () => {
  it("lists cwd, extra dirs, tool locations, and attachments", () => {
    const cwd = tmp();
    const extra = tmp();
    const dataDir = tmp();
    writeFileSync(join(cwd, "readme.md"), "# hi\n");
    const toolFile = join(cwd, "src.ts");
    writeFileSync(toolFile, "export const n = 1;\n");
    const attDir = join(dataDir, "sessions", "sess-files", "attachments");
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, "shot.jpg"), "not-really-jpeg");

    const s = session(cwd, {
      extraDirs: [extra],
      toolCalls: [
        {
          toolCallId: "t1",
          title: "Read",
          kind: "read",
          status: "completed",
          updatedAt: new Date().toISOString(),
          locations: [{ path: toolFile }],
        },
      ],
    });
    const files = listSessionFiles(s, config(dataDir));
    const paths = files.map((f) => f.path);
    expect(paths).toContain(cwd);
    expect(paths).toContain(extra);
    expect(paths).toContain(toolFile);
    expect(paths.some((p) => p.endsWith("shot.jpg"))).toBe(true);
    expect(files.find((f) => f.path === cwd)?.kind).toBe("folder");
    expect(files.find((f) => f.path.endsWith("shot.jpg"))?.kind).toBe("attachment");
  });

  it("reads text inside cwd and rejects paths outside the workspace", () => {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(cwd, "ok.txt"), "hello");
    writeFileSync(join(outside, "secret.txt"), "nope");
    const s = session(cwd);
    const cfg = config(tmp());
    const content = readSessionFile(s, cfg, join(cwd, "ok.txt"));
    expect(content.encoding).toBe("utf8");
    expect(content.text).toBe("hello");
    expect(content.binary).toBe(false);
    expect(() => readSessionFile(s, cfg, join(outside, "secret.txt"))).toThrow(/outside/);
  });

  it("allows extraDirs as roots", () => {
    const cwd = tmp();
    const extra = tmp();
    writeFileSync(join(extra, "other.md"), "from extra");
    const s = session(cwd, { extraDirs: [extra] });
    const content = readSessionFile(s, config(tmp()), join(extra, "other.md"));
    expect(content.text).toBe("from extra");
  });

  it("isPathAllowed rejects sibling escape", () => {
    const root = tmp();
    expect(isPathAllowed(join(root, "..", "nope"), [root])).toBe(false);
    expect(isPathAllowed(join(root, "ok"), [root])).toBe(true);
  });
});
