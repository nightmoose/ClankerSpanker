import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fdIdentity, ownLogFiles, rotateIfLarge } from "./log-rotate.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-log-rotate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rotateIfLarge", () => {
  it("leaves a small file alone", () => {
    const log = join(dir, "host.log");
    writeFileSync(log, "x".repeat(10));
    expect(rotateIfLarge(log, 100)).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("copies to .1 and truncates in place when over the limit", () => {
    const log = join(dir, "host.log");
    writeFileSync(log, "a".repeat(200));
    expect(rotateIfLarge(log, 100)).toBe(true);
    expect(statSync(log).size).toBe(0);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("a".repeat(200));
  });

  it("shifts older copies and keeps only `keep` of them", () => {
    const log = join(dir, "host.log");
    for (const round of ["1", "2", "3", "4"]) {
      writeFileSync(log, round.repeat(200));
      rotateIfLarge(log, 100, 2);
    }
    expect(readFileSync(`${log}.1`, "utf8")).toBe("4".repeat(200));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("3".repeat(200));
    expect(existsSync(`${log}.3`)).toBe(false);
  });

  it("an append-mode writer keeps writing at the start after truncation", () => {
    // launchd opens StandardOutPath with O_APPEND; this is why copy-then-truncate is safe.
    const log = join(dir, "host.log");
    writeFileSync(log, "");
    const fd = openSync(log, "a");
    writeSync(fd, "b".repeat(200));
    expect(rotateIfLarge(log, 100)).toBe(true);
    writeSync(fd, "after\n");
    closeSync(fd);
    expect(readFileSync(log, "utf8")).toBe("after\n");
  });

  it("is disabled by maxBytes 0", () => {
    const log = join(dir, "host.log");
    writeFileSync(log, "a".repeat(200));
    expect(rotateIfLarge(log, 0)).toBe(false);
  });
});

describe("ownLogFiles", () => {
  it("returns only the files that are this process's stdout/stderr", () => {
    const mine = join(dir, "clankerspanker-host.log");
    const other = join(dir, "grok-dispatch-host.log");
    writeFileSync(mine, "");
    writeFileSync(other, "");
    appendFileSync(join(dir, "notes.txt"), "");
    const fd = openSync(mine, "a");
    try {
      expect(ownLogFiles(dir, [fdIdentity(fd), null])).toEqual([mine]);
    } finally {
      closeSync(fd);
    }
  });

  it("finds nothing when stdout is not a file (e.g. systemd journal or a TTY)", () => {
    writeFileSync(join(dir, "clankerspanker-host.log"), "");
    expect(ownLogFiles(dir, [null, null])).toEqual([]);
  });
});
