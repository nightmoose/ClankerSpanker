import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RFC-044: shared/openapi.yaml must list every route server.ts handles, and
 * nothing it doesn't. The router is hand-rolled, so routes are read from the
 * source: `method === "X" && path === "/p"` and regex matchers
 * (`/^…$/.exec(path)` or `path.match(/^…$/)`) used with `method === "X" && fooMatch`.
 */
const ROOT = join(__dirname, "..", "..");
const SERVER = readFileSync(join(ROOT, "host", "src", "server.ts"), "utf8");
const SPEC = readFileSync(join(ROOT, "shared", "openapi.yaml"), "utf8");

/** Not REST endpoints (static UI, WebSocket upgrades) — documented, not routed via handleHttp. */
const NON_REST = new Set(["GET /", "GET /app", "GET /app/terminal.html", "GET /ws", "GET /ws/terminal"]);

type Route = string; // "METHOD /path/{p}"
const norm = (method: string, path: string): Route => `${method} ${path.replace(/\{[^}]+\}/g, "{}")}`;

export function routesFromServer(src: string): Set<Route> {
  const out = new Set<Route>();
  // method === "GET" && path === "/x"   (also `(path === "/a" || path === "/b")`)
  for (const m of src.matchAll(/method === "(GET|POST|PATCH|DELETE|PUT)" && \(?((?:path === "[^"]+"(?: \|\| )?)+)\)?/g)) {
    for (const p of m[2]!.matchAll(/path === "([^"]+)"/g)) out.add(norm(m[1]!, p[1]!));
  }
  // const fooMatch = /^\/a\/([^/]+)$/.exec(path)  |  path.match(/^…$/)
  const regex = new Map<string, string>();
  for (const m of src.matchAll(/const (\w+) = (?:\/\^(.+?)\$\/\.exec\(path\)|path\.match\(\/\^(.+?)\$\/\))/g)) {
    const body = (m[2] ?? m[3])!.replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "{}").replace(/\(\.\+\)/g, "{}");
    regex.set(m[1]!, body);
  }
  for (const m of src.matchAll(/method === "(GET|POST|PATCH|DELETE|PUT)" && (\w+Match)\b/g)) {
    const p = regex.get(m[2]!);
    if (p) out.add(norm(m[1]!, p));
  }
  return out;
}

export function routesFromSpec(spec: string): Set<Route> {
  const out = new Set<Route>();
  let current: string | null = null;
  for (const line of spec.split("\n")) {
    const p = /^ {2}(\/[^:]*):\s*$/.exec(line);
    if (p) {
      current = p[1]!;
      continue;
    }
    const m = /^ {4}(get|post|patch|delete|put):/.exec(line);
    if (m && current) out.add(norm(m[1]!.toUpperCase(), current));
  }
  return out;
}

describe("OpenAPI contract (RFC-044)", () => {
  const code = routesFromServer(SERVER);
  const spec = routesFromSpec(SPEC);

  it("finds a plausible number of routes (extractor sanity)", () => {
    expect(code.size).toBeGreaterThan(50);
  });

  it("documents every route server.ts handles", () => {
    const missing = [...code].filter((r) => !spec.has(r) && !NON_REST.has(r)).sort();
    expect(missing).toEqual([]);
  });

  it("documents nothing server.ts doesn't handle", () => {
    const stale = [...spec].filter((r) => !code.has(r) && !NON_REST.has(r)).sort();
    expect(stale).toEqual([]);
  });
});
