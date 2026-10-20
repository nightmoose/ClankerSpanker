import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// RFC-065: https://clankerspanker.tech holds the host token in localStorage.
// A script injected into that origin could use it, so the hosted site sends a
// strict CSP and the usual hardening headers from vercel.json.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const vercel = JSON.parse(readFileSync(join(repo, "vercel.json"), "utf8"));

function headersFor(source) {
  const rule = (vercel.headers ?? []).find((r) => r.source === source);
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
}

function directives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values];
      }),
  );
}

describe("hosted site security headers", () => {
  const h = headersFor("/(.*)");
  const csp = directives(h["content-security-policy"] ?? "");

  it("sends a CSP that allows only same-origin scripts", () => {
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("lets the page reach a gateway on loopback or a tailnet https name", () => {
    for (const src of ["http://127.0.0.1:*", "ws://127.0.0.1:*", "https:", "wss:"]) {
      expect(csp["connect-src"]).toContain(src);
    }
  });

  it("sends the other hardening headers", () => {
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("no-referrer");
  });

  it("keeps the shipped pages compatible: no inline scripts or event handlers", () => {
    const pages = [
      join(here, "index.html"),
      ...["docs", "download"].flatMap((d) =>
        readdirSync(join(repo, "site", d))
          .filter((f) => f.endsWith(".html"))
          .map((f) => join(repo, "site", d, f)),
      ),
    ];
    for (const page of pages) {
      const html = readFileSync(page, "utf8");
      for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
        expect(tag, `${page}: inline <script> is blocked by script-src 'self'`).toMatch(/\bsrc=/i);
      }
      expect(html, `${page}: inline event handler`).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});

// RFC-067: a shared link and a browser tab show what the product is.
describe("index.html share and icon metadata", () => {
  const html = readFileSync(join(here, "index.html"), "utf8");
  const meta = (attr, name) =>
    html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]+)"`))?.[1] ?? "";

  it("has a real title and description", () => {
    expect(html).toMatch(/<title>ClankerSpanker: [^<]+<\/title>/);
    expect(meta("name", "description").length).toBeGreaterThan(60);
  });

  it("has Open Graph and Twitter cards with an absolute image on the product origin", () => {
    for (const p of ["og:title", "og:description", "og:url", "og:image"]) expect(meta("property", p)).not.toBe("");
    expect(meta("property", "og:image")).toBe("https://clankerspanker.tech/og.png");
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  it("links icons that ship in the bundle", () => {
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="\.\/([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(["favicon.ico", "icons/apple-touch-icon.png"]));
    for (const h of [...hrefs, "og.png"]) expect(statSync(join(here, h)).size).toBeGreaterThan(0);
  });
});
