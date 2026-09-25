import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { extractBearer, isAuthorized, tokensMatch, unauthorizedBody } from "./auth.js";
import type { HostConfigFile } from "./types.js";

// The host gateway fronts a machine that can run arbitrary agent sessions, so
// this is the boundary that matters. It had no tests at all.

const TOKEN = "host-token-0123456789abcdef";
const config = { hostToken: TOKEN } as HostConfigFile;

/** Minimal IncomingMessage stand-in — only headers are read. */
function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("extractBearer", () => {
  it("reads a bearer token", () => {
    expect(extractBearer(req({ authorization: `Bearer ${TOKEN}` }))).toBe(TOKEN);
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer(req({ authorization: `bearer ${TOKEN}` }))).toBe(TOKEN);
    expect(extractBearer(req({ authorization: `BEARER ${TOKEN}` }))).toBe(TOKEN);
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractBearer(req({ authorization: `  Bearer   ${TOKEN}  ` }))).toBe(TOKEN);
  });

  it("returns null with no header, or a different scheme", () => {
    expect(extractBearer(req({}))).toBeNull();
    expect(extractBearer(req({ authorization: `Basic ${TOKEN}` }))).toBeNull();
    expect(extractBearer(req({ authorization: "Bearer" }))).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("accepts an exact match", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "X".repeat(TOKEN.length);
    expect(wrong).toHaveLength(TOKEN.length);
    expect(tokensMatch(wrong, TOKEN)).toBe(false);
  });

  it("rejects a prefix and a superstring without throwing", () => {
    // timingSafeEqual throws on length mismatch; we must guard before calling.
    expect(tokensMatch(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN + "x", TOKEN)).toBe(false);
  });

  // An unconfigured host must not accept an empty credential as valid.
  it("never authorises when either side is empty", () => {
    expect(tokensMatch("", TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN, undefined)).toBe(false);
  });

  it("handles multi-byte tokens without throwing", () => {
    // Buffer length is bytes, not characters — a naive length check on the
    // string would disagree with the byte comparison.
    expect(tokensMatch("tökén", "tökén")).toBe(true);
    expect(tokensMatch("tökén", "token")).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("accepts a valid bearer token", () => {
    expect(isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), config)).toBe(true);
  });

  it("rejects a wrong bearer token", () => {
    expect(isAuthorized(req({ authorization: "Bearer nope" }), config)).toBe(false);
  });

  it("rejects a request with no credential at all", () => {
    expect(isAuthorized(req({}), config)).toBe(false);
  });

  it("accepts the alternate header used by WS clients", () => {
    expect(isAuthorized(req({ "x-grok-dispatch-token": TOKEN }), config)).toBe(true);
  });

  it("rejects a wrong alternate header", () => {
    expect(isAuthorized(req({ "x-grok-dispatch-token": "nope" }), config)).toBe(false);
  });

  // Node gives an array when a header appears more than once. Previously this
  // fell through to `typeof alt === "string"` and returned false, which is the
  // safe outcome — pinning it so a future refactor doesn't start joining them.
  it("rejects a repeated alternate header rather than guessing", () => {
    expect(isAuthorized(req({ "x-grok-dispatch-token": [TOKEN, TOKEN] }), config)).toBe(false);
  });

  it("does not authorise anyone when the host token is unset", () => {
    const unconfigured = { hostToken: "" } as HostConfigFile;
    expect(isAuthorized(req({ authorization: "Bearer " }), unconfigured)).toBe(false);
    expect(isAuthorized(req({ "x-grok-dispatch-token": "" }), unconfigured)).toBe(false);
    expect(isAuthorized(req({}), unconfigured)).toBe(false);
  });

  it("prefers the Authorization header when both are present", () => {
    const r = req({ authorization: "Bearer wrong", "x-grok-dispatch-token": TOKEN });
    expect(isAuthorized(r, config)).toBe(false);
  });
});

describe("unauthorizedBody", () => {
  it("is valid JSON and leaks nothing about the expected token", () => {
    const body = unauthorizedBody();
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("Unauthorized");
    expect(body).not.toContain(TOKEN);
  });
});

describe("isAuthorized token headers (RFC-047)", () => {
  it("accepts the current x-clankerspanker-token header", () => {
    expect(isAuthorized(req({ "x-clankerspanker-token": TOKEN }), config)).toBe(true);
  });

  it("still accepts the legacy x-grok-dispatch-token header", () => {
    expect(isAuthorized(req({ "x-grok-dispatch-token": TOKEN }), config)).toBe(true);
  });

  it("rejects a wrong value in either header", () => {
    expect(isAuthorized(req({ "x-clankerspanker-token": "nope" }), config)).toBe(false);
    expect(isAuthorized(req({ "x-grok-dispatch-token": "nope" }), config)).toBe(false);
  });

  it("never authorises an empty configured token through either header", () => {
    const empty = { hostToken: "" } as HostConfigFile;
    expect(isAuthorized(req({ "x-clankerspanker-token": "" }), empty)).toBe(false);
    expect(isAuthorized(req({ "x-grok-dispatch-token": "" }), empty)).toBe(false);
  });
});
