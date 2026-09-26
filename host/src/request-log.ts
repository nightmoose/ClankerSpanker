/**
 * Remote client request log (RFC-057). The phone showed no sessions or
 * projects while the host looked healthy from this Mac, and nothing in the
 * log said whether the phone ever arrived. Log, for requests from other
 * machines only:
 *  - the first request from an address after it has been quiet, so "did the
 *    phone reach us?" is answerable;
 *  - every failed (>= 400) or slow request.
 * Path only — never the query string (it can carry legacy tokens).
 */
export const QUIET_MS = 5 * 60_000;
export const SLOW_MS = 3_000;

export interface RequestRecord {
  addr: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  bytes?: number;
}

export class RemoteRequestLog {
  private lastSeen = new Map<string, number>();

  constructor(
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly clock: () => number = Date.now,
  ) {}

  record(r: RequestRecord): void {
    const t = this.clock();
    const prev = this.lastSeen.get(r.addr);
    this.lastSeen.set(r.addr, t);
    const arrived = prev === undefined || t - prev > QUIET_MS;
    const bad = r.status >= 400 || r.ms > SLOW_MS;
    if (!arrived && !bad) return;
    const path = r.url.split("?")[0] || "/";
    const size = r.bytes !== undefined ? ` ${r.bytes}B` : "";
    const tag = arrived && !bad ? "client" : "client!";
    this.log(`[${tag}] ${r.addr} ${r.method} ${path} ${r.status} ${r.ms}ms${size}`);
  }
}

/** `::ffff:100.1.2.3` → `100.1.2.3`. */
export function cleanAddr(addr: string | undefined | null): string {
  const a = addr ?? "?";
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}
