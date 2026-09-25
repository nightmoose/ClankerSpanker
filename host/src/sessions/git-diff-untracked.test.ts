import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitDiff } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-diff-"));
  dirs.push(d);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(d, ".gitignore"), "ignored.log\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return d;
}

describe("gitDiff includes new files (RFC-033)", () => {
  it("shows tracked edits and untracked files, not ignored ones", async () => {
    const d = repo();
    writeFileSync(join(d, "calc.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(join(d, "test_calc.py"), "from calc import add\nassert add(2, 3) == 5\n");
    writeFileSync(join(d, "ignored.log"), "noise\n");
    writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const out = await gitDiff(d);
    expect(out).toContain("+    return a + b");
    expect(out).toContain("+++ b/test_calc.py");
    expect(out).toContain("+assert add(2, 3) == 5");
    expect(out).toContain("Binary file blob.bin added");
    expect(out).not.toContain("ignored.log");
  });

  it("is empty for a clean tree", async () => {
    expect(await gitDiff(repo())).toBe("");
  });
});
