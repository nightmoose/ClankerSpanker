/**
 * RFC-061/062 — Built-in SQL executor MCP server (stdio).
 * Spawned by the host when a session's project has a database configured.
 * DATABASE_URL is injected via env by the host; it is NEVER echoed in any output.
 */
import { createInterface } from "node:readline";
import pkg from "pg";

const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  process.stderr.write("[sql-mcp] DATABASE_URL is not set\n");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 10_000,
});

const SAFE_RE = /^\s*(select|explain|show|with)\s/i;
const MAX_ROWS = 200;

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errorReply(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

const SQL_TOOL = {
  name: "sql_execute",
  description:
    "Execute a read-only SQL query against this project's database. " +
    "Only SELECT, EXPLAIN, SHOW, and WITH (CTE) statements are accepted. " +
    "Results are capped at 200 rows. Use parameterized queries ($1, $2, …) " +
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

async function runQuery(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query must not be empty");
  if (!SAFE_RE.test(query)) {
    throw new Error("Only SELECT, EXPLAIN, SHOW, and WITH queries are supported.");
  }
  const params = Array.isArray(args.params) ? args.params : [];
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    const allRows = result.rows;
    const rows = allRows.slice(0, MAX_ROWS);
    const truncated = allRows.length > MAX_ROWS;
    return JSON.stringify(
      {
        rows,
        rowCount: result.rowCount ?? rows.length,
        fields: result.fields.map((f) => f.name),
        ...(truncated
          ? { truncated: true, note: `Showing first ${MAX_ROWS} of ${allRows.length} rows.` }
          : {}),
      },
      null,
      2,
    );
  } finally {
    client.release();
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (rawLine: string) => {
  const line = rawLine.trim();
  if (!line) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    errorReply(null, -32700, "Parse error");
    return;
  }

  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: unknown };
  const p =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  void (async () => {
    try {
      switch (method) {
        case "initialize":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: (p.protocolVersion as string) ?? "2024-11-05",
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
            const text = await runQuery(toolArgs);
            send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            send({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
            });
          }
          break;
        }

        default:
          errorReply(id, -32601, `Method not found: ${String(method)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errorReply(id, -32603, `Internal error: ${message}`);
    }
  })();
});

rl.on("close", () => {
  pool.end().catch(() => {});
  process.exit(0);
});
