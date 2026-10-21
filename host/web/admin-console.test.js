import { describe, expect, it } from "vitest";
import {
  adminConsoleHtml,
  controlPlanePaths,
  creditRows,
  pairPaths,
  profileLockCopy,
  publicCatalog,
  publicPushStatus,
  resolveGatewayUrls,
  urlsStayOnGateway,
  usageLine,
} from "./admin-console.js";
import { creditBadge } from "./credit-badge.js";

const LOOPBACK = "http://127.0.0.1:8787";
const TAILNET = "https://desk.tailnet.ts.net";

function model(overrides = {}) {
  return {
    hasToken: true,
    admin: false,
    wsOpen: true,
    health: { ok: true, version: "0.3.2", name: "ClankerSpanker" },
    healthError: "",
    push: { configured: true, deviceCount: 2, bundleId: "tech.clankerspanker.phone" },
    pushError: "",
    profiles: [
      { id: "night", name: "Night", usageLabel: "5h 12% · wk 2%" },
      { id: "day", name: "Day", usageLabel: "" },
    ],
    catalog: [{ id: "github", vendor: "GitHub" }],
    credits: creditRows([
      { id: "s1", title: "Billing", backend: "grok", creditsUsedDeltaPct: 6 },
      { id: "s2", title: "Claude chat", backend: "claude", creditsUsedDeltaPct: 40 },
      { id: "s3", title: "Quiet", backend: "grok" },
    ]),
    hosts: [
      {
        key: "host-a",
        hostId: "host-a",
        label: "Laptop",
        baseURL: LOOPBACK,
        tokenSaved: true,
        selected: true,
      },
      {
        key: "host-b",
        hostId: "host-b",
        label: "Desk",
        baseURL: TAILNET,
        tokenSaved: true,
        selected: false,
      },
    ],
    ...overrides,
  };
}

describe("admin console reads", () => {
  it("polls only the selected gateway", () => {
    const paths = controlPlanePaths({ adminView: true });
    expect(paths[0]).toBe("/sessions?view=summary");
    expect(paths).toContain("/health");
    expect(paths).toContain("/push/status");
    expect(paths).toContain("/profiles?admin=1&usage=1");
    expect(urlsStayOnGateway(LOOPBACK, paths)).toBe(true);
    const urls = resolveGatewayUrls(LOOPBACK, paths);
    for (const href of urls) expect(new URL(href).origin).toBe("http://127.0.0.1:8787");
    expect(urls.join(" ")).not.toContain("tailnet.ts.net");
    expect(urlsStayOnGateway(TAILNET, pairPaths())).toBe(true);
    expect(resolveGatewayUrls(TAILNET, pairPaths()).every((href) => href.startsWith(TAILNET))).toBe(true);
  });

  it("keeps the ordinary control plane off the admin-only reads", () => {
    const paths = controlPlanePaths({ adminView: false });
    expect(paths).toContain("/profiles?admin=1");
    expect(paths).not.toContain("/health");
    expect(paths).not.toContain("/push/status");
    expect(paths.some((p) => p.includes("usage=1"))).toBe(false);
  });

  it("keeps push status to configured, device count, and bundle id", () => {
    const status = publicPushStatus({
      configured: true,
      deviceCount: 2,
      bundleId: "tech.clankerspanker.phone",
      token: "device-token-should-not-appear",
      deviceToken: "abcdef0123456789",
      p8: "-----BEGIN PRIVATE KEY-----",
    });
    expect(status).toEqual({
      configured: true,
      deviceCount: 2,
      bundleId: "tech.clankerspanker.phone",
    });
    expect(JSON.stringify(status)).not.toContain("device-token");
    expect(JSON.stringify(status)).not.toContain("PRIVATE KEY");
    expect(publicPushStatus({ error: "nope" })).toBeNull();
  });

  it("reads the usage label the gateway sends with ?usage=1", () => {
    expect(usageLine({ usage: { label: "5h 12% · wk 2%" } })).toBe("5h 12% · wk 2%");
    expect(usageLine({ usage: { fiveHourPercent: 12.4, sevenDayPercent: 2 } })).toBe("5h 12% · wk 2%");
    expect(usageLine({})).toBe("");
  });

  it("lists catalog names and drops header material", () => {
    const rows = publicCatalog([
      {
        id: "github",
        vendor: "GitHub",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        env: { SECRET: "super-secret" },
      },
    ]);
    expect(rows).toEqual([{ id: "github", vendor: "GitHub" }]);
  });
});

describe("admin console page", () => {
  it("lists both hosts, with live rows only on the selected one", () => {
    const html = adminConsoleHtml(model());
    expect(html).toContain("Laptop");
    expect(html).toContain("Desk");
    expect(html).toContain("host-a");
    expect(html).toContain("host-b");
    expect(html).toContain("version 0.3.2");
    expect(html).toContain("WebSocket live");
    expect(html).toContain("Configured");
    expect(html).toContain("2 devices");
    expect(html).toContain("tech.clankerspanker.phone");
    expect(html).toContain("5h 12% · wk 2%");
    expect(html).toContain("GitHub (github)");
    expect(html).toContain("wk +6%");
    expect(html).toContain("credit-amber");
    expect(html).not.toContain("Claude chat");
    expect(html).not.toContain("token-a");
    expect(html).not.toContain("token-b");
    const desk = html.slice(html.indexOf('data-host-key="host-b"'));
    expect(desk).toContain("Select to load");
    expect(desk).not.toContain("version 0.3.2");
  });

  it("shows the profile lock copy and no create button for a remote browser", () => {
    const html = adminConsoleHtml(model({ admin: false }));
    expect(html).toContain(profileLockCopy(false));
    expect(html).toContain("locked");
    expect(html).not.toContain("Add profile");
    expect(html).not.toContain(">Create<");
  });

  it("says profile create still works on the Profiles tab when the gateway allows admin", () => {
    const html = adminConsoleHtml(model({ admin: true }));
    expect(html).toContain(profileLockCopy(true));
    expect(html).toContain("Profiles tab");
    expect(html).not.toContain("locked");
    expect(html).not.toContain("Add profile");
  });

  it("does not print a device token that arrived beside the push status", () => {
    const html = adminConsoleHtml(
      model({
        push: publicPushStatus({
          configured: false,
          deviceCount: 0,
          bundleId: null,
          token: "device-token-should-not-appear",
        }),
      }),
    );
    expect(html).toContain("Not configured");
    expect(html).toContain("0 devices");
    expect(html).not.toContain("device-token");
  });

  it("asks for a token before it describes the gateway as down", () => {
    const html = adminConsoleHtml(model({ hasToken: false, health: null, push: null }));
    expect(html).toContain("Save a token to load this.");
    expect(html).not.toContain("Gateway unreachable");
  });
});

describe("credit badge", () => {
  it("renders the existing Grok credit badge tiers", () => {
    expect(creditBadge({ creditsUsedDeltaPct: 3 })).toContain("credit-green");
    expect(creditBadge({ creditsUsedDeltaPct: 3 })).toContain("wk +3%");
    expect(creditBadge({ creditsUsedDeltaPct: 6 })).toContain("credit-amber");
    expect(creditBadge({ creditsUsedDeltaPct: 12 })).toContain("credit-red");
    expect(creditBadge({ creditsUsedDeltaPct: 0.4 })).toContain("wk +0.4%");
    expect(creditBadge({})).toBe("");
    expect(creditBadge({ creditsUsedDeltaPct: Number.NaN })).toBe("");
  });
});
