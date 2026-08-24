import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { TerminalHub, findPython3, ptyBridgePath } from "./session.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  static OPEN = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(String(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
}

function hasPython(): boolean {
  const bin = findPython3();
  if (!bin) return false;
  try {
    execFileSync(bin, ["-c", "import pty, select, struct"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("terminal hub", () => {
  const hub = new TerminalHub();
  afterEach(() => hub.shutdown());

  it("resolves the pty bridge script", () => {
    expect(existsSync(ptyBridgePath())).toBe(true);
  });

  it("echoes a command through a real PTY", async () => {
    if (!hasPython()) return;
    const ws = new FakeSocket();
    hub.attach(ws as unknown as import("ws").WebSocket, {
      shell: "/bin/sh",
      cols: 40,
      rows: 12,
    });
    expect(hub.size).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    ws.emit("message", JSON.stringify({ type: "in", data: "echo CS_PTY_OK\n" }));
    const deadline = Date.now() + 4000;
    let blob = "";
    while (Date.now() < deadline) {
      blob = ws.sent.join("\n");
      if (blob.includes("CS_PTY_OK")) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(blob).toContain("CS_PTY_OK");
    expect(ws.sent.some((s) => s.includes('"type":"ready"'))).toBe(true);
  });
});
