import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverGitRepos, discoverRepoProjects, projectIdForPath } from "./discover-repos.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "cs-home-"));
  dirs.push(h);
  return h;
}
const repo = (p: string) => mkdirSync(join(p, ".git"), { recursive: true });

describe("discoverGitRepos (RFC-036)", () => {
  it("finds repos in $HOME and two levels under code roots", () => {
    const h = home();
    repo(join(h, "cs-ux-sandbox"));
    repo(join(h, "Projects", "Alpha"));
    repo(join(h, "Projects", "clients", "Beta"));
    repo(join(h, "Projects", "a", "b", "TooDeep"));
    mkdirSync(join(h, "Projects", "NotARepo"), { recursive: true });
    const found = discoverGitRepos(h).map((p) => p.slice(h.length));
    expect(found).toEqual(expect.arrayContaining(["/cs-ux-sandbox", "/Projects/Alpha", "/Projects/clients/Beta"]));
    expect(found).not.toContain("/Projects/a/b/TooDeep");
    expect(found).not.toContain("/Projects/NotARepo");
  });

  it("skips hidden folders, node_modules and Library, and nested repos", () => {
    const h = home();
    repo(join(h, ".hidden-repo"));
    repo(join(h, "Library", "SomeRepo"));
    repo(join(h, "Projects", "node_modules", "pkg"));
    repo(join(h, "Projects", "Mono"));
    repo(join(h, "Projects", "Mono", "packages"));
    const found = discoverGitRepos(h).map((p) => p.slice(h.length));
    expect(found).toEqual(["/Projects/Mono"]);
  });

  it("respects the limit", () => {
    const h = home();
    for (let i = 0; i < 5; i++) repo(join(h, "Projects", `r${i}`));
    expect(discoverGitRepos(h, 3)).toHaveLength(3);
  });

  it("makes stable, collision-free project ids", () => {
    expect(projectIdForPath("/Users/a/Projects/My App")).toMatch(/^my-app-[0-9a-f]{6}$/);
    expect(projectIdForPath("/x/app")).not.toBe(projectIdForPath("/y/app"));
    const h = home();
    repo(join(h, "Projects", "Alpha"));
    expect(discoverRepoProjects(h)[0]).toMatchObject({ name: "Alpha", paths: [join(h, "Projects", "Alpha")] });
  });
});

describe("discover roots (RFC-037)", () => {
  it("reaches GitHub Desktop's ~/Documents/GitHub/<org>/<repo>", () => {
    const h = home();
    repo(join(h, "Documents", "GitHub", "Teladoc", "service-a"));
    repo(join(h, "Documents", "GitHub", "Teladoc", "service-b"));
    const found = discoverGitRepos(h).map((p) => p.slice(h.length));
    expect(found).toEqual(expect.arrayContaining(["/Documents/GitHub/Teladoc/service-a", "/Documents/GitHub/Teladoc/service-b"]));
  });

  it("scans configured extra roots, with ~ expanded", () => {
    const h = home();
    repo(join(h, "work", "client", "app"));
    expect(discoverGitRepos(h).map((p) => p.slice(h.length))).not.toContain("/work/client/app");
    expect(discoverGitRepos(h, 100, ["~/work"]).map((p) => p.slice(h.length))).toContain("/work/client/app");
  });
});
