import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { formatAddr, isAutoBind, isWildcardBind, resolveBindAddresses, tailscaleAddresses } from "./bind-addresses.js";

function iface(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) } as NetworkInterfaceInfo;
}

const NETS = {
  lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
  en0: [iface("192.168.1.220", "IPv4"), iface("fe80::1", "IPv6")],
  utun4: [iface("100.66.33.89", "IPv4"), iface("fd7a:115c:a1e0::1234", "IPv6")],
  utun9: [iface("100.200.1.1", "IPv4")], // CGNAT but not Tailscale's /10
};

describe("resolveBindAddresses (RFC-028)", () => {
  it("auto = loopback + Tailscale only, never the Wi-Fi address", () => {
    const addrs = resolveBindAddresses("auto", NETS);
    expect(addrs).toEqual(["127.0.0.1", "::1", "100.66.33.89", "fd7a:115c:a1e0::1234"]);
    expect(addrs).not.toContain("192.168.1.220");
    expect(addrs).not.toContain("100.200.1.1");
  });

  it("auto without Tailscale is loopback only", () => {
    expect(resolveBindAddresses("auto", { lo0: NETS.lo0, en0: NETS.en0 })).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps honoring the wildcard", () => {
    expect(resolveBindAddresses("0.0.0.0", NETS)).toEqual(["0.0.0.0"]);
    expect(resolveBindAddresses("", NETS)).toEqual(["0.0.0.0"]);
  });

  it("accepts an explicit comma-separated list", () => {
    expect(resolveBindAddresses("127.0.0.1, 100.66.33.89,127.0.0.1", NETS)).toEqual(["127.0.0.1", "100.66.33.89"]);
  });

  it("is case-insensitive for auto", () => {
    expect(isAutoBind(" AUTO ")).toBe(true);
    expect(isWildcardBind("::")).toBe(true);
    expect(isWildcardBind("auto")).toBe(false);
  });
});

describe("tailscaleAddresses", () => {
  it("skips internal and non-Tailscale addresses", () => {
    expect(tailscaleAddresses(NETS)).toEqual(["100.66.33.89", "fd7a:115c:a1e0::1234"]);
  });
});

describe("formatAddr", () => {
  it("brackets IPv6", () => {
    expect(formatAddr("::1")).toBe("[::1]");
    expect(formatAddr("127.0.0.1")).toBe("127.0.0.1");
  });
});
