import { randomBytes } from "node:crypto";

/**
 * Short-lived, single-use WebSocket tickets (RFC-029).
 *
 * Browsers cannot set headers on a WebSocket upgrade, so web clients used to
 * put the long-lived host token in the URL (`/ws?token=…`), where it lands in
 * proxy logs, history and screenshots. Instead a client that already holds
 * the token asks `POST /ws/ticket` (bearer auth) for a ticket and connects
 * with `?ticket=…`. A ticket works once, within `ttlMs`.
 */
export class WsTicketStore {
  private readonly tickets = new Map<string, number>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): { ticket: string; expiresInMs: number } {
    this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, this.now() + this.ttlMs);
    return { ticket, expiresInMs: this.ttlMs };
  }

  /** True once per issued, unexpired ticket. */
  consume(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    const expires = this.tickets.get(ticket);
    if (expires === undefined) return false;
    this.tickets.delete(ticket);
    return expires >= this.now();
  }

  get size(): number {
    this.prune();
    return this.tickets.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, exp] of this.tickets) if (exp < t) this.tickets.delete(k);
  }
}
