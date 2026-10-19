import { describe, expect, it } from "vitest";
import {
  HOSTED_PRODUCT_ORIGIN,
  corsAllowedFor,
  corsHeadersFor,
  isTrustedLocalPageRequest,
  nativeOnlyRefusal,
  stripPort,
} from "./trusted-local.js";

const NAMES = new Set(["localhost", "127.0.0.1", "::1", "my-host", "my-host.local", "100.64.0.10"]);

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
    expect(isTrustedLocalPageRequest(req("10.0.0.50", { host: "100.64.0.10:8787" }), NAMES)).toBe(false);
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
    expect(stripPort("100.64.0.10:8787")).toBe("100.64.0.10");
    expect(stripPort("[::1]:8787")).toBe("::1");
    expect(stripPort("my-host.local")).toBe("my-host.local");
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

describe("corsHeadersFor", () => {
  it("reflects the hosted product origin and opts in to private network access", () => {
    const headers = corsHeadersFor("/sessions", HOSTED_PRODUCT_ORIGIN);
    expect(headers).toMatchObject({
      "Access-Control-Allow-Origin": HOSTED_PRODUCT_ORIGIN,
      "Access-Control-Allow-Private-Network": "true",
      Vary: "Origin",
    });
    expect(headers?.["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers?.["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });

  it("accepts the hosted origin in any case", () => {
    expect(corsHeadersFor("/ws/ticket", "HTTPS://ClankerSpanker.tech")).toMatchObject({
      "Access-Control-Allow-Origin": HOSTED_PRODUCT_ORIGIN,
      "Access-Control-Allow-Private-Network": "true",
    });
  });

  it("keeps the wildcard for clients that have no website origin", () => {
    for (const origin of [undefined, "", "null"]) {
      const headers = corsHeadersFor("/health", origin);
      expect(headers?.["Access-Control-Allow-Origin"]).toBe("*");
      expect(headers?.["Access-Control-Allow-Private-Network"]).toBeUndefined();
    }
  });

  it("refuses every other website origin, including previews and www", () => {
    for (const origin of [
      "https://www.clankerspanker.tech",
      "https://clankerspanker.tech.evil.example",
      "http://clankerspanker.tech",
      "https://preview.vercel.app",
      "https://evil.example",
      "http://127.0.0.1:8787",
    ]) {
      expect(corsHeadersFor("/sessions", origin)).toBeNull();
    }
  });

  it("never attaches CORS or private-network headers to token-less routes", () => {
    for (const path of ["/", "/setup", "/connect.json", "/mcp/oauth/callback"]) {
      expect(corsHeadersFor(path, HOSTED_PRODUCT_ORIGIN)).toBeNull();
      expect(corsHeadersFor(path, undefined)).toBeNull();
    }
  });
});

describe("nativeOnlyRefusal (RFC-059, RFC-060)", () => {
  const h = (headers: Record<string, string>) => ({ headers });

  it("allows a native client, which sends no Origin, from any address", () => {
    expect(nativeOnlyRefusal(h({ host: "100.64.0.10:8787" }))).toBeNull();
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787" }))).toBeNull();
  });

  it("allows the gateway's own page on the direct listener", () => {
    expect(
      nativeOnlyRefusal(
        h({ host: "100.64.0.10:8787", origin: "http://100.64.0.10:8787", "sec-fetch-site": "same-origin" }),
      ),
    ).toBeNull();
    expect(nativeOnlyRefusal(h({ host: "localhost:8787", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("refuses the hosted product site", () => {
    expect(
      nativeOnlyRefusal(h({ host: "127.0.0.1:8787", origin: HOSTED_PRODUCT_ORIGIN, "sec-fetch-site": "cross-site" })),
    ).toMatch(/native apps/);
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", origin: HOSTED_PRODUCT_ORIGIN }))).toMatch(/native apps/);
  });

  it("refuses foreign and null origins", () => {
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", origin: "https://evil.example" }))).not.toBeNull();
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", origin: "null" }))).not.toBeNull();
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", origin: "https://127.0.0.1:8787" }))).not.toBeNull();
  });

  it("refuses a cross-site browser request that omits Origin", () => {
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" }))).not.toBeNull();
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", "sec-fetch-site": "same-site" }))).not.toBeNull();
  });

  it("refuses anything that came through tailscale serve, same-origin or not", () => {
    expect(nativeOnlyRefusal(h({ host: "node.tail.ts.net", "tailscale-user-login": "me@example.com" }))).toMatch(
      /tailscale serve/,
    );
    expect(
      nativeOnlyRefusal(
        h({
          host: "node.tail.ts.net",
          origin: "http://node.tail.ts.net",
          "sec-fetch-site": "same-origin",
          "tailscale-user-login": "me@example.com",
        }),
      ),
    ).toMatch(/tailscale serve/);
    expect(nativeOnlyRefusal(h({ host: "127.0.0.1:8787", "tailscale-user-login": "" }))).not.toBeNull();
  });
});
