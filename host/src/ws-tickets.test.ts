import { describe, expect, it } from "vitest";
import { WsTicketStore } from "./ws-tickets.js";

describe("WsTicketStore (RFC-029)", () => {
  it("accepts an issued ticket exactly once", () => {
    const s = new WsTicketStore();
    const { ticket } = s.issue();
    expect(s.consume(ticket)).toBe(true);
    expect(s.consume(ticket)).toBe(false);
  });

  it("rejects an expired ticket", () => {
    let t = 1_000;
    const s = new WsTicketStore(30_000, () => t);
    const { ticket } = s.issue();
    t += 30_001;
    expect(s.consume(ticket)).toBe(false);
  });

  it("rejects unknown, empty and missing tickets", () => {
    const s = new WsTicketStore();
    s.issue();
    expect(s.consume("nope")).toBe(false);
    expect(s.consume("")).toBe(false);
    expect(s.consume(null)).toBe(false);
  });

  it("prunes expired tickets so the map cannot grow without bound", () => {
    let t = 0;
    const s = new WsTicketStore(10, () => t);
    for (let i = 0; i < 50; i++) s.issue();
    t = 100;
    expect(s.size).toBe(0);
  });

  it("issues unguessable, distinct tickets", () => {
    const s = new WsTicketStore();
    const a = s.issue().ticket;
    const b = s.issue().ticket;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});
