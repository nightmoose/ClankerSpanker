import { describe, expect, it } from "vitest";
import { expandHome, inferProjectId, nonAbsolutePaths, projectOverlapWarnings } from "./project-resolve.js";

const H = "/Users/alex";
const P = (id: string, ...paths: string[]) => ({ id, name: id, paths, path: paths[0] ?? "" });

describe("expandHome (RFC-032)", () => {
  it("expands ~ and ~/x only", () => {
    expect(expandHome("~", H)).toBe(H);
    expect(expandHome("~/journeyquest", H)).toBe(`${H}/journeyquest`);
    expect(expandHome("/abs/~/x", H)).toBe("/abs/~/x");
    expect(expandHome("rel", H)).toBe("rel");
  });
});

describe("inferProjectId (RFC-032)", () => {
  const projects = [
    P("projects", "/Users/alex/Projects"),
    P("cs", "/Users/alex/Projects/GrokDispatch"),
    P("arcade", "/Users/alex/Projects/ArcadeBox"),
    P("merc", "/Users/alex/mercenary", "/Users/alex/mercenary-ios"),
  ];

  it("picks the longest matching project path", () => {
    expect(inferProjectId(projects, "/Users/alex/Projects/GrokDispatch/host")).toBe("cs");
    expect(inferProjectId(projects, "/Users/alex/Projects/Other")).toBe("projects");
    expect(inferProjectId(projects, "/Users/alex/mercenary-ios")).toBe("merc");
  });

  it("does not confuse sibling prefixes", () => {
    expect(inferProjectId([P("merc", "/Users/alex/mercenary")], "/Users/alex/mercenary-ios")).toBeUndefined();
  });

  it("is case-insensitive (Mercenary-ios vs mercenary-ios)", () => {
    expect(inferProjectId(projects, "/Users/alex/Mercenary-ios")).toBe("merc");
  });

  it("refuses to guess when two projects claim the same folder", () => {
    const overlapping = [P("projects", "/Users/alex/Projects"), P("cs", "/Users/alex/Projects/GrokDispatch", "/Users/alex/Projects")];
    expect(inferProjectId(overlapping, "/Users/alex/Projects")).toBeUndefined();
    expect(inferProjectId(overlapping, "/Users/alex/Projects/GrokDispatch")).toBe("cs");
  });

  it("ignores archived projects and unmatched folders", () => {
    expect(inferProjectId([{ ...P("old", "/Users/alex/x"), archived: true }], "/Users/alex/x")).toBeUndefined();
    expect(inferProjectId(projects, "/Users/alex")).toBeUndefined();
    expect(inferProjectId(projects, undefined)).toBeUndefined();
  });
});

describe("nonAbsolutePaths", () => {
  it("flags relative paths but accepts ~", () => {
    expect(nonAbsolutePaths(["~/x", "/a", "rel/b"])).toEqual(["rel/b"]);
  });
});

describe("projectOverlapWarnings", () => {
  it("reports same, inside and contains", () => {
    const others = [P("projects", "/Users/alex/Projects"), P("cs", "/Users/alex/Projects/GrokDispatch")];
    const w = projectOverlapWarnings({ id: "new", paths: ["/Users/alex/Projects"] }, others as never);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("also a path");
    expect(w[1]).toContain("contains");
    const inside = projectOverlapWarnings({ id: "new", paths: ["/Users/alex/Projects/X"] }, others as never);
    expect(inside[0]).toContain("inside");
  });
});

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeProject, resolveProjectPath } from "./config.js";
import type { HostConfigFile } from "./types.js";

describe("config integration (RFC-032)", () => {
  it("normalizeProject expands ~ in paths", () => {
    const p = normalizeProject({ id: "jq", name: "JourneyQuest", paths: ["~/journeyquest"] } as never);
    expect(p.paths[0]).not.toContain("~");
    expect(p.path).toBe(p.paths[0]);
  });

  it("resolveProjectPath tags a cwd-only session with the containing project", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-proj-")));
    const repo = join(root, "repo");
    const sub = join(repo, "packages", "core");
    mkdirSync(sub, { recursive: true });
    const config = {
      projects: [normalizeProject({ id: "repo", name: "Repo", paths: [repo] } as never)],
      allowCustomPaths: true,
    } as unknown as HostConfigFile;
    expect(resolveProjectPath(config, undefined, sub)).toEqual({ path: sub, projectId: "repo" });
    expect(resolveProjectPath(config, undefined, root).projectId).toBeUndefined();
  });
});
