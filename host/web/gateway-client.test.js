import { describe, expect, it } from "vitest";
import {
  HOSTED_PRODUCT_ORIGIN,
  LOOPBACK_APP,
  LOOPBACK_GATEWAY,
  defaultGatewayURL,
  explainFetchFailure,
  gatewayTerminalURL,
  hostUpdateAvailable,
  isChromeUserAgent,
  isLoopbackHost,
  isTailnetServeURL,
  loopbackFetchInit,
  normalizeHostURL,
  openWebSocket,
  productSiteKind,
  publicPageNotice,
  resetWebSocketOptionsProbe,
  websocketOptions,
} from "./gateway-client.js";

const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const EDGE = CHROME.replace("Chrome/154.0.0.0", "Chrome/154.0.0.0 Edg/154.0.0.0");

describe("loopback fetch and websocket options", () => {
  it("marks only loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("100.64.0.10")).toBe(false);
    expect(isLoopbackHost("node.tailnet.ts.net")).toBe(false);
  });

  it("sets targetAddressSpace only for loopback URLs", () => {
    expect(loopbackFetchInit("http://127.0.0.1:8787/sessions")).toEqual({
      targetAddressSpace: "loopback",
      mode: "cors",
    });
    expect(loopbackFetchInit("http://localhost:8787/sessions")).toEqual({
      targetAddressSpace: "loopback",
      mode: "cors",
    });
    expect(loopbackFetchInit("http://[::1]:8787/sessions")).toEqual({
      targetAddressSpace: "loopback",
      mode: "cors",
    });
    expect(loopbackFetchInit("https://node.tailnet.ts.net/sessions")).toEqual({});
    expect(loopbackFetchInit("http://100.64.0.10:8787/sessions")).toEqual({});
    expect(websocketOptions("http://127.0.0.1:8787")).toEqual({ targetAddressSpace: "loopback" });
    expect(websocketOptions("https://node.tailnet.ts.net")).toBeNull();
  });
});

describe("which browser can use the public page", () => {
  it("recognizes Chrome and rejects the browsers that share parts of its string", () => {
    expect(isChromeUserAgent(CHROME)).toBe(true);
    expect(isChromeUserAgent(FIREFOX)).toBe(false);
    expect(isChromeUserAgent(SAFARI)).toBe(false);
    expect(isChromeUserAgent(EDGE)).toBe(false);
    expect(isChromeUserAgent(CHROME.replace("Chrome/", "CriOS/"))).toBe(false);
    expect(isChromeUserAgent(CHROME, { brave: true })).toBe(false);
  });

  it("explains the limit on the public site and stays quiet on the gateway page", () => {
    const firefox = publicPageNotice({ hostname: "clankerspanker.tech", userAgent: FIREFOX });
    expect(firefox).toContain("Chrome");
    expect(firefox).toContain(LOOPBACK_APP);
    expect(firefox).toContain("does not redirect");
    expect(publicPageNotice({ hostname: "clankerspanker.tech", userAgent: CHROME })).toBe("");
    expect(publicPageNotice({ hostname: "127.0.0.1", userAgent: FIREFOX })).toBe("");
    expect(publicPageNotice({ hostname: "localhost", userAgent: SAFARI })).toBe("");
  });

  it("tells a preview visitor not to paste a token", () => {
    const notice = publicPageNotice({ hostname: "clankerspanker-abc.vercel.app", userAgent: CHROME });
    expect(notice).toContain("preview");
    expect(notice).toContain(HOSTED_PRODUCT_ORIGIN);
    expect(notice).toContain("Do not paste a host token");
  });

  it("replaces a silent network error on the public site", () => {
    const explained = explainFetchFailure({
      hostname: "clankerspanker.tech",
      userAgent: FIREFOX,
      baseURL: LOOPBACK_GATEWAY,
      errorMessage: "Failed to fetch",
    });
    expect(explained).toContain(LOOPBACK_APP);
    const chrome = explainFetchFailure({
      hostname: "clankerspanker.tech",
      userAgent: CHROME,
      baseURL: LOOPBACK_GATEWAY,
      errorMessage: "Failed to fetch",
    });
    expect(chrome).toContain("allow loopback");
    expect(chrome).toContain(LOOPBACK_GATEWAY);
    const rejected = explainFetchFailure({
      hostname: "clankerspanker.tech",
      userAgent: CHROME,
      baseURL: LOOPBACK_GATEWAY,
      errorMessage: "The host rejected this browser's token",
    });
    expect(rejected).toContain("rejected");
  });
});

describe("WebSocket options bag", () => {
  const SUBPROTOCOL = "Failed to construct 'WebSocket': The subprotocol '[object Object]' is invalid";

  function rejectingSocket(calls) {
    return function WS(url, protocols) {
      calls.push(protocols);
      if (protocols && typeof protocols === "object") {
        throw new Error(SUBPROTOCOL);
      }
      this.url = url;
    };
  }

  function acceptingSocket(calls) {
    return function WS(url, protocols) {
      calls.push(protocols);
      this.url = url;
      this.protocols = protocols;
    };
  }

  it("catches the Chrome 154 subprotocol throw once and then skips the bag", () => {
    resetWebSocketOptionsProbe();
    const calls = [];
    const WS = rejectingSocket(calls);
    const bag = { targetAddressSpace: "loopback" };
    const first = openWebSocket("ws://127.0.0.1:8787/ws", bag, WS);
    const second = openWebSocket("ws://127.0.0.1:8787/ws", bag, WS);
    expect(first.url).toBe("ws://127.0.0.1:8787/ws");
    expect(second.url).toBe("ws://127.0.0.1:8787/ws");
    // First open: bag throws, then a plain socket. Second open skips the bag.
    expect(calls).toEqual([bag, undefined, undefined]);
  });

  it("keeps passing the bag when the constructor accepts it", () => {
    resetWebSocketOptionsProbe();
    const calls = [];
    const WS = acceptingSocket(calls);
    const bag = { targetAddressSpace: "loopback" };
    openWebSocket("ws://127.0.0.1:8787/ws", bag, WS);
    openWebSocket("ws://127.0.0.1:8787/ws", bag, WS);
    expect(calls).toEqual([bag, bag]);
  });

  it("does not pass a bag for a non-loopback socket", () => {
    resetWebSocketOptionsProbe();
    const calls = [];
    const WS = acceptingSocket(calls);
    openWebSocket("wss://node.tailnet.ts.net/ws", null, WS);
    expect(calls).toEqual([undefined]);
  });
});

describe("default gateway URL", () => {
  it("uses a stored URL, otherwise loopback on the public site", () => {
    expect(defaultGatewayURL({ hostname: "clankerspanker.tech", stored: "http://127.0.0.1:9999" })).toBe(
      "http://127.0.0.1:9999",
    );
    expect(defaultGatewayURL({ hostname: "clankerspanker.tech", stored: "" })).toBe(LOOPBACK_GATEWAY);
    expect(defaultGatewayURL({ hostname: "www.clankerspanker.tech", stored: "" })).toBe(LOOPBACK_GATEWAY);
    expect(defaultGatewayURL({ hostname: "127.0.0.1", stored: "" })).toBe("");
    expect(gatewayTerminalURL("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/app/terminal.html");
    expect(gatewayTerminalURL("http://127.0.0.1:9999/")).toBe("http://127.0.0.1:9999/app/terminal.html");
    expect(productSiteKind("clankerspanker.tech.evil.example")).toBeNull();
  });
});

describe("tailnet serve URL (RFC-058 phase 2)", () => {
  const TS = "https://node.tailnet.ts.net";

  it("recognizes https://<node>.<tailnet>.ts.net only", () => {
    expect(isTailnetServeURL(TS)).toBe(true);
    expect(isTailnetServeURL(`${TS}/`)).toBe(true);
    expect(isTailnetServeURL("https://NODE.Tailnet.TS.NET")).toBe(true);
    expect(isTailnetServeURL("http://node.tailnet.ts.net")).toBe(false);
    expect(isTailnetServeURL("https://tailnet.ts.net")).toBe(false);
    expect(isTailnetServeURL("https://node.tailnet.ts.net.evil.example")).toBe(false);
    expect(isTailnetServeURL("https://ts.net.evil.example")).toBe(false);
    expect(isTailnetServeURL(LOOPBACK_GATEWAY)).toBe(false);
    expect(isTailnetServeURL("not a url")).toBe(false);
  });

  it("normalizes what the Host URL field accepts", () => {
    expect(normalizeHostURL(" https://node.tailnet.ts.net/ ")).toBe(TS);
    expect(normalizeHostURL("node.tailnet.ts.net")).toBe(TS);
    expect(normalizeHostURL("http://127.0.0.1:8787/")).toBe(LOOPBACK_GATEWAY);
    expect(normalizeHostURL("http://node.tailnet.ts.net")).toBe("http://node.tailnet.ts.net");
    expect(normalizeHostURL("")).toBe("");
  });

  it("declares no target address space for a ts.net gateway", () => {
    expect(loopbackFetchInit(`${TS}/sessions`)).toEqual({});
    expect(websocketOptions(TS)).toBeNull();
    expect(JSON.stringify(loopbackFetchInit(`${TS}/sessions`))).not.toContain("targetAddressSpace");
  });

  it("drops the Chrome-only notice for Safari and Firefox on a ts.net gateway", () => {
    for (const ua of [SAFARI, FIREFOX]) {
      expect(publicPageNotice({ hostname: "clankerspanker.tech", userAgent: ua, baseURL: TS })).toBe("");
      const loop = publicPageNotice({ hostname: "clankerspanker.tech", userAgent: ua, baseURL: LOOPBACK_GATEWAY });
      expect(loop).toContain("tailscale serve");
      expect(loop).toContain("ts.net");
      expect(loop).toContain(LOOPBACK_APP);
    }
    const preview = publicPageNotice({ hostname: "x.vercel.app", userAgent: SAFARI, baseURL: TS });
    expect(preview).toContain("Do not paste a host token");
  });

  it("explains a failed tailnet fetch in tailnet terms, in any browser", () => {
    for (const ua of [SAFARI, FIREFOX, CHROME]) {
      const msg = explainFetchFailure({
        hostname: "clankerspanker.tech",
        userAgent: ua,
        baseURL: TS,
        errorMessage: "Load failed",
      });
      expect(msg).toContain(TS);
      expect(msg).toContain("tailscale serve");
      expect(msg).not.toContain("loopback");
    }
    const rejected = explainFetchFailure({
      hostname: "clankerspanker.tech",
      userAgent: SAFARI,
      baseURL: TS,
      errorMessage: "The host rejected this browser's token",
    });
    expect(rejected).toContain("rejected");
  });
});

describe("hostUpdateAvailable (RFC-059)", () => {
  it("shows on the gateway's own /app/ page, loopback or Tailscale IP", () => {
    expect(
      hostUpdateAvailable({ pageOrigin: "http://127.0.0.1:8787", baseURL: "http://127.0.0.1:8787", hostname: "127.0.0.1" }),
    ).toBe(true);
    expect(
      hostUpdateAvailable({ pageOrigin: "http://100.64.0.10:8787", baseURL: "http://100.64.0.10:8787", hostname: "100.64.0.10" }),
    ).toBe(true);
  });

  it("hides on the hosted site and previews", () => {
    expect(
      hostUpdateAvailable({ pageOrigin: HOSTED_PRODUCT_ORIGIN, baseURL: LOOPBACK_GATEWAY, hostname: "clankerspanker.tech" }),
    ).toBe(false);
    expect(
      hostUpdateAvailable({ pageOrigin: "https://x.vercel.app", baseURL: "https://x.vercel.app", hostname: "x.vercel.app" }),
    ).toBe(false);
  });

  it("hides through tailscale serve, even same-origin", () => {
    const serve = "https://node.tail1234.ts.net";
    expect(hostUpdateAvailable({ pageOrigin: serve, baseURL: serve, hostname: "node.tail1234.ts.net" })).toBe(false);
  });

  it("hides when the page points at another gateway or the URL is junk", () => {
    expect(
      hostUpdateAvailable({ pageOrigin: "http://127.0.0.1:8787", baseURL: "http://100.64.0.10:8787", hostname: "127.0.0.1" }),
    ).toBe(false);
    expect(hostUpdateAvailable({ pageOrigin: "http://127.0.0.1:8787", baseURL: "", hostname: "127.0.0.1" })).toBe(false);
  });
});
