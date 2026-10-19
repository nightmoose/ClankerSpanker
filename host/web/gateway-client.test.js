import { describe, expect, it } from "vitest";
import {
  HOSTED_PRODUCT_ORIGIN,
  LOOPBACK_APP,
  LOOPBACK_GATEWAY,
  defaultGatewayURL,
  explainFetchFailure,
  isChromeUserAgent,
  isLoopbackHost,
  loopbackFetchInit,
  productSiteKind,
  publicPageNotice,
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

describe("default gateway URL", () => {
  it("uses a stored URL, otherwise loopback on the public site", () => {
    expect(defaultGatewayURL({ hostname: "clankerspanker.tech", stored: "http://127.0.0.1:9999" })).toBe(
      "http://127.0.0.1:9999",
    );
    expect(defaultGatewayURL({ hostname: "clankerspanker.tech", stored: "" })).toBe(LOOPBACK_GATEWAY);
    expect(defaultGatewayURL({ hostname: "www.clankerspanker.tech", stored: "" })).toBe(LOOPBACK_GATEWAY);
    expect(defaultGatewayURL({ hostname: "127.0.0.1", stored: "" })).toBe("");
    expect(productSiteKind("clankerspanker.tech.evil.example")).toBeNull();
  });
});
