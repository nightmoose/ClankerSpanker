import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite } from "../../site/build.mjs";
import { relativeCredentialSends, scanTree } from "../../site/static-origin-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("relative credential sends", () => {
  it("flags the gateway terminal's relative ticket post", () => {
    const src = readFileSync(join(here, "terminal.html"), "utf8");
    const hits = relativeCredentialSends(src);
    expect(hits.some((hit) => hit.url === "/ws/ticket")).toBe(true);
    expect(hits.some((hit) => hit.url === "/connect.json")).toBe(false);
  });

  it("allows a same-origin read that does not send the token", () => {
    expect(relativeCredentialSends('fetch("/connect.json", { cache: "no-store" })')).toEqual([]);
  });

  it("allows the control plane, which resolves API calls against the gateway base URL", () => {
    const src = readFileSync(join(here, "app.js"), "utf8");
    expect(relativeCredentialSends(src)).toEqual([]);
    const html = readFileSync(join(here, "index.html"), "utf8");
    expect(relativeCredentialSends(html)).toEqual([]);
  });

  it("publishes neither the terminal page nor a relative credential send", () => {
    const out = mkdtempSync(join(tmpdir(), "cs-site-"));
    dirs.push(out);
    buildSite(out);
    expect(existsSync(join(out, "terminal.html"))).toBe(false);
    expect(existsSync(join(out, "app", "terminal.html"))).toBe(false);
    expect(existsSync(join(out, "app.js"))).toBe(true);
    expect(existsSync(join(out, "app", "app.js"))).toBe(true);
    expect(existsSync(join(out, "docs", "index.html"))).toBe(true);
    expect(scanTree(out)).toEqual([]);
    const published = readFileSync(join(out, "app.js"), "utf8");
    expect(published).toContain("gatewayTerminalURL");
    expect(published).not.toContain('fetch("/ws/ticket"');
  });
});
