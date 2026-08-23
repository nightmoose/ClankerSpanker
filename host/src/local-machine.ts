import { networkInterfaces } from "node:os";

/**
 * True when `addr` is IPv4/IPv6 loopback (including IPv4-mapped IPv6).
 */
export function isLoopbackAddr(addr?: string | null): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("::ffff:127.")
  );
}

/** Every address this process's host currently owns (loopback + NIC + Tailscale). */
export function localMachineAddresses(): Set<string> {
  const set = new Set<string>(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const n of list ?? []) {
      const a = n.address?.trim();
      if (!a) continue;
      set.add(a);
      // Node reports IPv4 clients on an IPv6 dual-stack socket as ::ffff:x.x.x.x
      if (!a.includes(":")) set.add(`::ffff:${a}`);
    }
  }
  return set;
}

/**
 * True when the peer is this machine — loopback OR any of our own interface
 * addresses. Same-Mac browsing via LAN IP / Tailscale must still reach the
 * Profiles manager; a phone on Tailscale has a different address and is denied.
 */
export function isLocalMachineAddr(addr?: string | null): boolean {
  if (!addr) return false;
  if (isLoopbackAddr(addr)) return true;
  return localMachineAddresses().has(addr);
}
