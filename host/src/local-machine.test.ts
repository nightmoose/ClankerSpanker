import { describe, expect, it } from "vitest";
import { isLocalMachineAddr, isLoopbackAddr, localMachineAddresses } from "./local-machine.js";

describe("isLoopbackAddr", () => {
  it("accepts IPv4, IPv6, and IPv4-mapped loopback", () => {
    expect(isLoopbackAddr("127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("::1")).toBe(true);
    expect(isLoopbackAddr("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddr("10.0.0.2")).toBe(false);
    expect(isLoopbackAddr(null)).toBe(false);
  });
});

describe("isLocalMachineAddr", () => {
  it("treats every address this host owns as local (LAN / Tailscale from this Mac)", () => {
    const mine = [...localMachineAddresses()];
    expect(mine.length).toBeGreaterThan(0);
    for (const addr of mine) {
      expect(isLocalMachineAddr(addr)).toBe(true);
    }
    expect(isLocalMachineAddr("8.8.8.8")).toBe(false);
    expect(isLocalMachineAddr("1.2.3.4")).toBe(false);
  });
});
