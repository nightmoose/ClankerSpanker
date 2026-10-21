import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  approvalSocketMode,
  callApprovalBroker,
  hostApprovalHandlers,
  startApprovalBroker,
} from "./approval-broker.js";

const TOKEN = "host-token-value";

function memoryBroker(sessionId: string) {
  const decisions = new Map<string, { status: string; comment?: string }>();
  const seen: { sessionId?: string; body?: string } = {};
  let polls = 0;
  const brokerPromise = startApprovalBroker({
    sessionId,
    async create(body) {
      seen.sessionId = body.sessionId;
      seen.body = JSON.stringify(body);
      const approvalId = `ap-${decisions.size + 1}`;
      decisions.set(approvalId, { status: "pending" });
      return { approvalId };
    },
    async poll(approvalId) {
      polls += 1;
      return decisions.get(approvalId) ?? null;
    },
  });
  return { brokerPromise, decisions, seen, polls: () => polls };
}

describe("approval broker", () => {
  it("creates and polls only for the session the host bound", async () => {
    const { brokerPromise, decisions, seen } = memoryBroker("bound-session");
    const broker = await brokerPromise;
    try {
      const created = await callApprovalBroker(broker.socketPath, {
        op: "create",
        toolName: "Bash",
        title: "Bash: ls",
        toolInput: { command: "ls" },
        sessionId: "attacker",
        token: TOKEN,
      });
      expect(created.ok).toBe(true);
      expect(created.approvalId).toBe("ap-1");
      expect(created).not.toHaveProperty("token");
      expect(seen.sessionId).toBe("bound-session");
      expect(seen.body).not.toContain(TOKEN);
      expect(seen.body).not.toContain("attacker");

      const pending = await callApprovalBroker(broker.socketPath, {
        op: "poll",
        approvalId: created.approvalId,
      });
      expect(pending).toEqual({ ok: true, status: "pending" });

      decisions.set("ap-1", { status: "approved", comment: "ship it" });
      const done = await callApprovalBroker(broker.socketPath, {
        op: "poll",
        approvalId: created.approvalId,
      });
      expect(done).toEqual({ ok: true, status: "approved", comment: "ship it" });
    } finally {
      broker.close();
    }
  });

  it("rejects anything except create and poll, and hides handler errors", async () => {
    const broker = await startApprovalBroker({
      sessionId: "s",
      async create() {
        throw new Error(`boom ${TOKEN}`);
      },
      async poll() {
        return { status: "approved" };
      },
    });
    try {
      const unsupported = await callApprovalBroker(broker.socketPath, { op: "approve", approvalId: "x" });
      expect(unsupported).toEqual({ ok: false, error: "unsupported" });
      const missing = await callApprovalBroker(broker.socketPath, { op: "create", title: "t" });
      expect(missing).toEqual({ ok: false, error: "toolName required" });
      const failed = await callApprovalBroker(broker.socketPath, { op: "create", toolName: "Bash", title: "t" });
      expect(failed.ok).toBe(false);
      expect(JSON.stringify(failed)).not.toContain(TOKEN);
      const foreign = await callApprovalBroker(broker.socketPath, { op: "poll", approvalId: "not-mine" });
      expect(foreign).toEqual({ ok: false, error: "unknown approval" });
    } finally {
      broker.close();
    }
  });

  it("does not poll an id created on a different broker", async () => {
    const a = memoryBroker("a");
    const b = memoryBroker("b");
    const left = await a.brokerPromise;
    const right = await b.brokerPromise;
    try {
      const created = await callApprovalBroker(left.socketPath, { op: "create", toolName: "Edit", title: "e" });
      const poll = await callApprovalBroker(right.socketPath, { op: "poll", approvalId: created.approvalId });
      expect(poll).toEqual({ ok: false, error: "unknown approval" });
      expect(b.polls()).toBe(0);
    } finally {
      left.close();
      right.close();
    }
  });

  it("refuses an oversized frame and a closed socket", async () => {
    const broker = await startApprovalBroker({
      sessionId: "s",
      async create() {
        return { approvalId: "should-not-run" };
      },
      async poll() {
        return null;
      },
    });
    try {
      const mode = approvalSocketMode(broker.socketPath);
      expect(mode.directory).toBe(0o700);
      expect(mode.socket & 0o077).toBe(0);
      const huge = await callApprovalBroker(broker.socketPath, { op: "create", blob: "x".repeat(70_000) });
      expect(huge).toEqual({ ok: false, error: "payload too large" });
      const path = broker.socketPath;
      broker.close();
      await expect(callApprovalBroker(path, { op: "create", toolName: "Bash", title: "t" })).rejects.toThrow();
    } finally {
      broker.close();
    }
  });
});

describe("host approval handlers", () => {
  it("sends the host token only on the existing approval routes", async () => {
    const hits: { method: string; url: string; authorization: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        hits.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ approvalId: "ap-9", token: TOKEN }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "approved", comment: "ok", token: TOKEN }));
      });
    });
    const url = await listen(server);
    const broker = await startApprovalBroker({
      sessionId: "bound-session",
      ...hostApprovalHandlers({
        sessionId: "bound-session",
        hostBaseUrl: url,
        hostToken: TOKEN,
      }),
    });
    try {
      const created = await callApprovalBroker(broker.socketPath, {
        op: "create",
        toolName: "Bash",
        title: "Bash: ls",
        toolInput: { command: "ls" },
        sessionId: "attacker",
        token: "client-supplied",
      });
      expect(created).toEqual({ ok: true, approvalId: "ap-9" });
      const polled = await callApprovalBroker(broker.socketPath, { op: "poll", approvalId: "ap-9" });
      expect(polled).toEqual({ ok: true, status: "approved", comment: "ok" });
      expect(JSON.stringify(created)).not.toContain(TOKEN);
      expect(JSON.stringify(polled)).not.toContain(TOKEN);
      expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual([
        "POST /internal/claude-approval",
        "GET /internal/claude-approval/ap-9",
      ]);
      expect(hits.every((h) => h.authorization === `Bearer ${TOKEN}`)).toBe(true);
      const posted = JSON.parse(hits[0]!.body) as Record<string, unknown>;
      expect(posted.sessionId).toBe("bound-session");
      expect(posted).not.toHaveProperty("token");
    } finally {
      broker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
