/**
 * RFC-061 — Built-in SQL executor MCP server (stdio).
 * Spawned by the host when a session's project has a database configured.
 * DATABASE_URL is injected via env by the host; it is NEVER echoed in any output.
 *
 * The request handling is exported (`createSqlMcpHandler`) so tests can drive
 * it with a fake pool; the stdio loop only runs when this file is the entry
 * point.
 */
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "pg";

export const MAX_ROWS = 200;

const SAFE_RE = /^\s*(select|explain|show|with)\s/i;

export const SQL_TOOL = {
  name: "sql_execute",
  description:
    "Execute a read-only SQL query against this project's database. " +
    "Only SELECT, EXPLAIN, SHOW, and WITH (CTE) statements are accepted, one statement per call, " +
    "and each runs inside a READ ONLY transaction that is rolled back. " +
    `Results are capped at ${MAX_ROWS} rows. Use parameterized queries ($1, $2, …) ` +
    "to safely interpolate values.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "SQL to execute. Must start with SELECT, EXPLAIN, SHOW, or WITH.",
      },
      params: {
        type: "array",
        items: {},
        description: "Positional parameters for $1, $2, … placeholders (optional).",
      },
    },
    required: ["query"],
  },
};

/** The slice of `pg.PoolClient` this server uses. */
export interface SqlClient {
  query(
    q: string | { text: string; values?: unknown[]; queryMode?: "extended" },
  ): Promise<{ rows: unknown[]; rowCount: number | null; fields?: Array<{ name: string }> }>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
}

/**
 * Remove the connection string (and its password on its own) from `text`.
 * pg and DNS errors can carry the host or user; the password and the full
 * URL must never reach the agent.
 */
export function redactSecret(text: string, connectionString: string): string {
  let out = text;
  const needles = new Set<string>();
  if (connectionString) needles.add(connectionString);
  try {
    const u = new URL(connectionString);
    if (u.password) {
      needles.add(u.password);
      try {
        needles.add(decodeURIComponent(u.password));
      } catch {
        /* malformed escape: raw form already added */
      }
    }
  } catch {
    /* not a URL; full-string match only */
  }
  // Longest first so the full URL is replaced before its password.
  for (const n of [...needles].sort((a, b) => b.length - a.length)) {
    if (n.length < 3) continue;
    out = out.split(n).join("[redacted]");
  }
  // Any other postgres URL with credentials (e.g. pg echoing a parsed form).
  return out.replace(/postgres(?:ql)?:\/\/[^\s"'@/]*@/gi, "postgres://[redacted]@");
}

export async function runQuery(pool: SqlPool, args: Record<string, unknown>): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query must not be empty");
  if (!SAFE_RE.test(query)) {
    throw new Error("Only SELECT, EXPLAIN, SHOW, and WITH queries are supported.");
  }
  if (args.params !== undefined && !Array.isArray(args.params)) {
    throw new Error("params must be an array");
  }
  const params = (args.params as unknown[] | undefined) ?? [];
  const client = await pool.connect();
  try {
    // READ ONLY blocks writes the prefix check misses (data-modifying CTEs,
    // EXPLAIN ANALYZE DELETE …). The extended protocol refuses multiple
    // statements, so `select 1; commit; drop table x` cannot escape it.
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = await client.query({ text: query, values: params, queryMode: "extended" });
      const allRows = result.rows ?? [];
      const rows = allRows.slice(0, MAX_ROWS);
      const truncated = allRows.length > MAX_ROWS;
      return JSON.stringify(
        {
          rows,
          rowCount: result.rowCount ?? rows.length,
          fields: (result.fields ?? []).map((f) => f.name),
          ...(truncated
            ? { truncated: true, note: `Showing first ${MAX_ROWS} of ${allRows.length} rows.` }
            : {}),
        },
        null,
        2,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

type Send = (obj: unknown) => void;

/** Returns a handler for one JSON-RPC line. Resolves once any reply is sent. */
export function createSqlMcpHandler(opts: {
  pool: SqlPool;
  connectionString: string;
  send: Send;
}): (rawLine: string) => Promise<void> {
  const { pool, connectionString } = opts;
  const send: Send = (obj) => opts.send(obj);
  const errorReply = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message: redactSecret(message, connectionString) } });

  return async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      errorReply(null, -32700, "Parse error");
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      errorReply(null, -32600, "Invalid Request");
      return;
    }

    const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: unknown };
    const p =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};

    try {
      switch (method) {
        case "initialize":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "sql", version: "1.0.0" },
            },
          });
          break;

        case "initialized":
        case "notifications/initialized":
          break;

        case "ping":
          send({ jsonrpc: "2.0", id, result: {} });
          break;

        case "tools/list":
          send({ jsonrpc: "2.0", id, result: { tools: [SQL_TOOL] } });
          break;

        case "tools/call": {
          const toolName = String(p.name ?? "");
          if (toolName !== "sql_execute") {
            errorReply(id, -32601, `Unknown tool: ${toolName}`);
            break;
          }
          const toolArgs =
            p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
              ? (p.arguments as Record<string, unknown>)
              : {};
          try {
            const text = await runQuery(pool, toolArgs);
            send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
          } catch (err) {
            const message = redactSecret(err instanceof Error ? err.message : String(err), connectionString);
            send({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
            });
          }
          break;
        }

        default:
          // Notifications (no id) get no reply.
          if (id !== undefined) errorReply(id, -32601, `Method not found: ${String(method)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorReply(id, -32603, `Internal error: ${message}`);
    }
  };
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main(): void {
  const DATABASE_URL = process.env.DATABASE_URL ?? "";
  if (!DATABASE_URL) {
    process.stderr.write("[sql-mcp] DATABASE_URL is not set\n");
    process.exit(1);
  }
  const pool = new pkg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  // An idle-client error would otherwise crash the process with the raw error.
  pool.on("error", () => undefined);
  const handle = createSqlMcpHandler({
    pool: pool as unknown as SqlPool,
    connectionString: DATABASE_URL,
    send: (obj) => process.stdout.write(JSON.stringify(obj) + "\n"),
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line: string) => void handle(line));
  rl.on("close", () => {
    pool.end().catch(() => {});
    process.exit(0);
  });
}

if (isEntryPoint()) main();
