import { describe, expect, it } from "vitest";
import { wsUpgradeAuthorized } from "./server.js";
import { WsTicketStore } from "./ws-tickets.js";

const cfg = { hostToken: "a".repeat(48) };
function req(url: string, remoteAddress: string, headers: Record<string, string> = {}) {
  return { url, headers, socket: { remoteAddress } };
}

describe("wsUpgradeAuthorized (RFC-029)", () => {
  it("accepts the bearer header from anywhere", () => {
    const r = req("/ws", "100.101.1.2", { authorization: `Bearer ${cfg.hostToken}` });
    expect(wsUpgradeAuthorized(r, cfg, new WsTicketStore())).toBe(true);
  });

  it("accepts a fresh ticket once, from anywhere", () => {
    const t = new WsTicketStore();
    const { ticket } = t.issue();
    expect(wsUpgradeAuthorized(req(`/ws?ticket=${ticket}`, "100.101.1.2"), cfg, t)).toBe(true);
    expect(wsUpgradeAuthorized(req(`/ws?ticket=${ticket}`, "100.101.1.2"), cfg, t)).toBe(false);
  });

  it("refuses the legacy ?token= from the network", () => {
    const r = req(`/ws?token=${cfg.hostToken}`, "100.101.1.2");
    expect(wsUpgradeAuthorized(r, cfg, new WsTicketStore())).toBe(false);
  });

  it("still accepts the legacy ?token= from this machine", () => {
    const r = req(`/ws/terminal?token=${cfg.hostToken}&cols=80`, "127.0.0.1");
    expect(wsUpgradeAuthorized(r, cfg, new WsTicketStore())).toBe(true);
  });

  it("refuses a wrong token and no credentials", () => {
    expect(wsUpgradeAuthorized(req("/ws?token=wrong", "127.0.0.1"), cfg, new WsTicketStore())).toBe(false);
    expect(wsUpgradeAuthorized(req("/ws", "127.0.0.1"), cfg, new WsTicketStore())).toBe(false);
  });

  it("never authorises with an empty configured token", () => {
    const empty = { hostToken: "" };
    expect(wsUpgradeAuthorized(req("/ws?token=", "127.0.0.1"), empty, new WsTicketStore())).toBe(false);
  });
});
