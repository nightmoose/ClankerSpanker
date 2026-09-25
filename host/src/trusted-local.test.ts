import { describe, expect, it } from "vitest";
import { corsAllowedFor, isTrustedLocalPageRequest, stripPort } from "./trusted-local.js";

const NAMES = new Set(["localhost", "127.0.0.1", "::1", "mac-mini", "mac-mini.local", "100.66.33.89"]);

function req(remoteAddress: string, headers: Record<string, string>) {
  return { socket: { remoteAddress }, headers };
}

describe("isTrustedLocalPageRequest", () => {
  it("accepts a loopback request addressed to localhost", () => {
    expect(isTrustedLocalPageRequest(req("127.0.0.1", { host: "localhost:8787" }), NAMES)).toBe(true);
  });

  it("accepts a same-origin fetch from the /app/ page", () => {
    const r = req("127.0.0.1", {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "same-origin",
    });
    expect(isTrustedLocalPageRequest(r, NAMES)).toBe(true);
  });

  it("refuses a peer on the network (phone, other laptop)", () => {
    expect(isTrustedLocalPageRequest(req("192.168.1.50", { host: "100.66.33.89:8787" }), NAMES)).toBe(false);
  });

  it("refuses DNS rebinding (loopback peer, foreign Host header)", () => {
    expect(isTrustedLocalPageRequest(req("127.0.0.1", { host: "evil.example:8787" }), NAMES)).toBe(false);
  });

  it("refuses a cross-origin fetch from a web page", () => {
    const r = req("127.0.0.1", { host: "localhost:8787", origin: "https://evil.example" });
    expect(isTrustedLocalPageRequest(r, NAMES)).toBe(false);
  });

  it("refuses cross-site fetch metadata even without Origin", () => {
    const r = req("127.0.0.1", { host: "localhost:8787", "sec-fetch-site": "cross-site" });
    expect(isTrustedLocalPageRequest(r, NAMES)).toBe(false);
  });

  it("refuses a missing Host header", () => {
    expect(isTrustedLocalPageRequest(req("127.0.0.1", {}), NAMES)).toBe(false);
  });
});

describe("stripPort", () => {
  it("handles names, IPv4 and bracketed IPv6", () => {
    expect(stripPort("localhost:8787")).toBe("localhost");
    expect(stripPort("100.66.33.89:8787")).toBe("100.66.33.89");
    expect(stripPort("[::1]:8787")).toBe("::1");
    expect(stripPort("mac-mini.local")).toBe("mac-mini.local");
  });
});

describe("corsAllowedFor", () => {
  it("never allows CORS on token-less routes", () => {
    for (const p of ["/", "/setup", "/connect.json", "/mcp/oauth/callback"]) {
      expect(corsAllowedFor(p)).toBe(false);
    }
  });
  it("keeps CORS on token-authenticated API routes", () => {
    expect(corsAllowedFor("/sessions")).toBe(true);
    expect(corsAllowedFor("/host/self")).toBe(true);
  });
});
