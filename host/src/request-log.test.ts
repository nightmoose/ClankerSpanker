import { describe, expect, it } from "vitest";
import { QUIET_MS, RemoteRequestLog, cleanAddr } from "./request-log.js";

function setup() {
  const lines: string[] = [];
  let t = 1_000_000;
  const log = new RemoteRequestLog((l) => lines.push(l), () => t);
  return { lines, log, advance: (ms: number) => (t += ms) };
}

const ok = { addr: "100.64.0.30", method: "GET", url: "/sessions", status: 200, ms: 40, bytes: 300_000 };

describe("RemoteRequestLog (RFC-057)", () => {
  it("logs the first request from a client, then stays quiet while it polls", () => {
    const { lines, log, advance } = setup();
    log.record(ok);
    advance(10_000);
    log.record({ ...ok, url: "/profiles" });
    expect(lines).toEqual(["[client] 100.64.0.30 GET /sessions 200 40ms 300000B"]);
  });

  it("logs again after the client has been quiet", () => {
    const { lines, log, advance } = setup();
    log.record(ok);
    advance(QUIET_MS + 1);
    log.record(ok);
    expect(lines).toHaveLength(2);
  });

  it("always logs failures and slow requests, without the query string", () => {
    const { lines, log } = setup();
    log.record(ok);
    log.record({ ...ok, url: "/projects?token=secret", status: 401, bytes: undefined });
    log.record({ ...ok, ms: 5_000 });
    expect(lines.slice(1)).toEqual([
      "[client!] 100.64.0.30 GET /projects 401 40ms",
      "[client!] 100.64.0.30 GET /sessions 200 5000ms 300000B",
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("strips the IPv4-mapped prefix", () => {
    expect(cleanAddr("::ffff:100.64.0.30")).toBe("100.64.0.30");
    expect(cleanAddr(undefined)).toBe("?");
  });
});
