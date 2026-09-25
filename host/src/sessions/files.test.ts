import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

describe("RFC-023: PDF mime + new-in-cwd surfacing", () => {
  it("mimeFor .pdf resolves via readSessionFile", () => {
    const cwd = tmp();
    // Non-text bytes so looksText() sends us down the base64 path.
    writeFileSync(join(cwd, "sketch.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0x01, 0x02]));
    const s = session(cwd);
    const content = readSessionFile(s, config(tmp()), join(cwd, "sketch.pdf"));
    expect(content.mimeType).toBe("application/pdf");
    expect(content.binary).toBe(true);
    expect(content.encoding).toBe("base64");
    expect(content.data && content.data.length > 0).toBe(true);
  });

  it("surfaces top-level files in cwd modified during the session", () => {
    const cwd = tmp();
    const dataDir = tmp();
    // File written BEFORE session start — must not appear.
    const oldFile = join(cwd, "old.txt");
    writeFileSync(oldFile, "before");
    const oneHourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(oldFile, oneHourAgo, oneHourAgo);
    // Session starts first; the file is written AFTER it — must appear.
    // (Creating the session after the write made this pass only when both
    // landed in the same millisecond — flaky on Linux CI.)
    const started = new Date(Date.now() - 1_000).toISOString();
    const s = session(cwd, { createdAt: started, updatedAt: started });
    writeFileSync(join(cwd, "sketch.pdf"), "not-really-pdf");
    const files = listSessionFiles(s, config(dataDir));
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("sketch.pdf"))).toBe(true);
    expect(paths.some((p) => p.endsWith("old.txt"))).toBe(false);
    expect(files.find((f) => f.path.endsWith("sketch.pdf"))?.kind).toBe("file");
  });

  it("skips dotfiles in the shallow cwd scan", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".hidden"), "secret");
    const s = session(cwd);
    const files = listSessionFiles(s, config(tmp()));
    expect(files.some((f) => f.path.endsWith(".hidden"))).toBe(false);
  });

  it("no shallow scan when the session predates the RFC (no createdAt)", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "recent.txt"), "hi");
    const s = session(cwd);
    // Blank createdAt is not something the type allows, but we test the guard
    // by pointing at a distant-future createdAt so nothing qualifies.
    s.createdAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const files = listSessionFiles(s, config(tmp()));
    expect(files.some((f) => f.path.endsWith("recent.txt"))).toBe(false);
  });
});

import { symlinkSync, truncateSync } from "node:fs";

describe("RFC-042: file viewer bounds", () => {
  it("refuses a symlink inside the workspace that points outside it", () => {
    const cwd = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
    const dataDir = tmp();
    expect(() => readSessionFile(session(cwd), config(dataDir), "link.txt")).toThrow(/outside/);
  });

  it("reads only the capped prefix of a huge file", () => {
    const cwd = tmp();
    const big = join(cwd, "huge.log");
    writeFileSync(big, "start\n");
    truncateSync(big, 64 * 1024 * 1024); // sparse 64 MB
    const out = readSessionFile(session(cwd), config(tmp()), "huge.log");
    expect(out.truncated).toBe(true);
  });
});
