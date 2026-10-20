import { describe, expect, it } from "vitest";
import { demoHref, demoRequested, landingView } from "./landing.js";

// RFC-067: a visitor with no host configured sees the explainer; the demo
// opens only when ?demo=1 asks for it.

describe("landingView", () => {
  it("shows the explainer when no host token is saved", () => {
    expect(landingView({ token: "", demo: false })).toBe("explainer");
    expect(landingView({ token: undefined, demo: false })).toBe("explainer");
    expect(landingView({ token: "   ", demo: false })).toBe("explainer");
  });

  it("shows the app once a token is saved", () => {
    expect(landingView({ token: "abc123", demo: false })).toBe("app");
  });

  it("shows the demo only when chosen, token or not", () => {
    expect(landingView({ token: "", demo: true })).toBe("demo");
    expect(landingView({ token: "abc123", demo: true })).toBe("demo");
  });
});

describe("demoRequested", () => {
  it("is off by default, including on a gateway page with other parameters", () => {
    expect(demoRequested("")).toBe(false);
    expect(demoRequested("?update=1")).toBe(false);
    expect(demoRequested("?token=abc")).toBe(false);
    expect(demoRequested("?demo=0")).toBe(false);
  });

  it("is on for ?demo=1, ?demo=true, and a bare ?demo", () => {
    expect(demoRequested("?demo=1")).toBe(true);
    expect(demoRequested("?demo=true")).toBe(true);
    expect(demoRequested("?demo")).toBe(true);
    expect(demoRequested("?x=1&demo=1")).toBe(true);
  });
});

describe("demoHref", () => {
  it("adds and removes demo and keeps the rest", () => {
    expect(demoHref({ pathname: "/", search: "" }, true)).toBe("/?demo=1");
    expect(demoHref({ pathname: "/app/", search: "?demo=1" }, false)).toBe("/app/");
    expect(demoHref({ pathname: "/", search: "?x=1&demo=1", hash: "#h" }, false)).toBe("/?x=1#h");
  });
});
