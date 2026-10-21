import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * RFC-071. A sandboxed job may ask for a phone approval only through this
 * socket. The host token stays in the parent process. The socket accepts
 * two operations: create a request for the session the host bound, and
 * poll that request. It cannot approve, reject, or call any other route.
 */

const MAX_FRAME = 64 * 1024;
const MAX_TOOL_NAME = 200;
const MAX_TITLE = 500;

export interface ApprovalCreateBody {
  sessionId: string;
  toolName: string;
  title: string;
  toolInput?: unknown;
}

export interface ApprovalBrokerHandlers {
  create(body: ApprovalCreateBody): Promise<{ approvalId: string }>;
  poll(approvalId: string): Promise<{ status: string; comment?: string } | null>;
}

export interface ApprovalBroker {
  /** Host path. Mode 0600 inside a 0700 directory. */
  readonly socketPath: string;
  /** Private directory that holds the socket. Not mounted into the jail. */
  readonly directory: string;
  close(): void;
}

interface BrokerState {
  server: Server;
  directory: string;
  socketPath: string;
  sockets: Set<Socket>;
  created: Set<string>;
  closed: boolean;
}

export async function startApprovalBroker(
  opts: ApprovalBrokerHandlers & { sessionId: string },
): Promise<ApprovalBroker> {
  if (!opts.sessionId.trim()) throw new Error("approval broker needs a session id");
  const directory = mkdtempSync(path.join(tmpdir(), "cs-approval-"));
  chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "approval.sock");
  const state: BrokerState = {
    server: createServer({ allowHalfOpen: true }),
    directory,
    socketPath,
    sockets: new Set(),
    created: new Set(),
    closed: false,
  };
  state.server.on("connection", (socket) => onConnection(socket, state, opts));
  state.server.on("error", () => undefined);
  state.server.unref();
  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      state.server.close();
      rmSync(directory, { recursive: true, force: true });
      reject(err);
    };
    state.server.once("error", fail);
    state.server.listen(socketPath, () => {
      state.server.removeListener("error", fail);
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        /* the directory is already 0700 */
      }
      resolve();
    });
  });
  return {
    socketPath,
    directory,
    close() {
      if (state.closed) return;
      state.closed = true;
      for (const socket of state.sockets) socket.destroy();
      state.server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Host-side client for the two routes the phone hook already uses.
 * The bearer token is attached here and is never written to the socket.
 */
export function hostApprovalHandlers(opts: {
  sessionId: string;
  hostBaseUrl: string;
  hostToken: string;
  fetchImpl?: typeof fetch;
}): ApprovalBrokerHandlers {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.hostBaseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${opts.hostToken}` };
  return {
    async create(body) {
      const res = await fetchImpl(`${base}/internal/claude-approval`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: body.sessionId,
          toolName: body.toolName,
          title: body.title,
          toolInput: body.toolInput,
        }),
      });
      if (!res.ok) throw new Error("approval create failed");
      const parsed = (await res.json()) as { approvalId?: unknown };
      if (typeof parsed.approvalId !== "string" || !parsed.approvalId) {
        throw new Error("approval create failed");
      }
      return { approvalId: parsed.approvalId };
    },
    async poll(approvalId) {
      const res = await fetchImpl(
        `${base}/internal/claude-approval/${encodeURIComponent(approvalId)}`,
        { headers },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("approval poll failed");
      const parsed = (await res.json()) as { status?: unknown; comment?: unknown };
      if (typeof parsed.status !== "string" || !parsed.status) return null;
      const comment = typeof parsed.comment === "string" ? parsed.comment.slice(0, 500) : undefined;
      return comment ? { status: parsed.status, comment } : { status: parsed.status };
    },
  };
}

/** One request / one response. Used by tests. The hook speaks the same frames. */
export function callApprovalBroker(
  socketPath: string,
  msg: unknown,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("approval socket timeout"));
    }, timeoutMs);
    const finish = (err?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value ?? {});
    };
    socket.on("error", (err) => finish(err));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(buf.trim()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish(new Error("bad approval response"));
          return;
        }
        finish(undefined, parsed as Record<string, unknown>);
      } catch {
        finish(new Error("bad approval response"));
      }
    });
    socket.end(JSON.stringify(msg) + "\n");
  });
}

function onConnection(
  socket: Socket,
  state: BrokerState,
  opts: ApprovalBrokerHandlers & { sessionId: string },
): void {
  state.sockets.add(socket);
  socket.unref();
  socket.on("close", () => state.sockets.delete(socket));
  socket.on("error", () => socket.destroy());
  let buf = Buffer.alloc(0);
  let tooBig = false;
  let replied = false;
  const reply = (obj: Record<string, unknown>) => {
    if (replied || state.closed) return;
    replied = true;
    try {
      socket.end(JSON.stringify(obj) + "\n");
    } catch {
      socket.destroy();
    }
  };
  socket.setTimeout(15_000);
  socket.on("timeout", () => {
    reply({ ok: false, error: "timeout" });
  });
  socket.on("data", (chunk: Buffer) => {
    if (tooBig || replied) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_FRAME) {
      tooBig = true;
      buf = Buffer.alloc(0);
      reply({ ok: false, error: "payload too large" });
    }
  });
  socket.on("end", () => {
    if (tooBig || replied) return;
    void dispatch(buf.toString("utf8"), state, opts)
      .then(reply)
      .catch(() => reply({ ok: false, error: "approval request failed" }));
  });
}

async function dispatch(
  text: string,
  state: BrokerState,
  opts: ApprovalBrokerHandlers & { sessionId: string },
): Promise<Record<string, unknown>> {
  const nl = text.indexOf("\n");
  const line = (nl === -1 ? text : text.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : text.slice(nl + 1).trim();
  if (!line) return { ok: false, error: "empty" };
  if (rest) return { ok: false, error: "trailing data" };
  let msg: unknown;
  try {
    msg = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, error: "unsupported" };
  }
  const rec = msg as Record<string, unknown>;
  if (rec.op === "create") return createOp(rec, state, opts);
  if (rec.op === "poll") return pollOp(rec, state, opts);
  return { ok: false, error: "unsupported" };
}

async function createOp(
  rec: Record<string, unknown>,
  state: BrokerState,
  opts: ApprovalBrokerHandlers & { sessionId: string },
): Promise<Record<string, unknown>> {
  if (typeof rec.toolName !== "string" || rec.toolName.trim() === "") {
    return { ok: false, error: "toolName required" };
  }
  if (rec.toolName.length > MAX_TOOL_NAME) return { ok: false, error: "toolName too long" };
  const title = rec.title === undefined ? rec.toolName : rec.title;
  if (typeof title !== "string" || title.length === 0) return { ok: false, error: "title required" };
  if (title.length > MAX_TITLE) return { ok: false, error: "title too long" };
  const created = await opts.create({
    sessionId: opts.sessionId,
    toolName: rec.toolName,
    title,
    toolInput: rec.toolInput,
  });
  if (!created.approvalId) return { ok: false, error: "approval request failed" };
  state.created.add(created.approvalId);
  return { ok: true, approvalId: created.approvalId };
}

async function pollOp(
  rec: Record<string, unknown>,
  state: BrokerState,
  opts: ApprovalBrokerHandlers,
): Promise<Record<string, unknown>> {
  const approvalId = rec.approvalId;
  if (typeof approvalId !== "string" || !state.created.has(approvalId)) {
    return { ok: false, error: "unknown approval" };
  }
  const found = await opts.poll(approvalId);
  if (!found) return { ok: false, error: "unknown approval" };
  const out: Record<string, unknown> = { ok: true, status: found.status };
  if (found.comment) out.comment = found.comment.slice(0, 500);
  return out;
}

export function approvalSocketMode(socketPath: string): { socket: number; directory: number } {
  const socket = statSync(socketPath).mode & 0o777;
  const directory = statSync(path.dirname(socketPath)).mode & 0o777;
  return { socket, directory };
}
