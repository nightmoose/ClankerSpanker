import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ROWS,
  SQL_TOOL,
  createSqlMcpHandler,
  redactSecret,
  type SqlClient,
  type SqlPool,
} from "./sql-execute.js";

const PASSWORD = "hunter2-Sup3r$ecret";
const URL_ = `postgresql://postgres.abc:${encodeURIComponent(PASSWORD)}@db.abc.supabase.co:5432/postgres`;

type QueryArg = Parameters<SqlClient["query"]>[0];

function fakePool(opts: {
  rows?: unknown[];
  fields?: string[];
  fail?: Error;
  connectFail?: Error;
} = {}) {
  const calls: QueryArg[] = [];
  const release = vi.fn();
  const connect = vi.fn(async (): Promise<SqlClient> => {
    if (opts.connectFail) throw opts.connectFail;
    return {
      release,
      query: async (q) => {
        calls.push(q);
        if (typeof q === "string") return { rows: [], rowCount: null };
        if (opts.fail) throw opts.fail;
        const rows = opts.rows ?? [];
        return { rows, rowCount: rows.length, fields: (opts.fields ?? []).map((name) => ({ name })) };
      },
    };
  });
  const pool: SqlPool = { connect };
  return { pool, calls, release, connect };
}

function harness(pool: SqlPool) {
  const out: Array<Record<string, any>> = [];
  const handle = createSqlMcpHandler({ pool, connectionString: URL_, send: (o) => out.push(o as Record<string, any>) });
  const rpc = async (method: string, params?: unknown, id: unknown = 1) => {
    out.length = 0;
    await handle(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return out[0];
  };
  const callTool = (args: unknown, name = "sql_execute") => rpc("tools/call", { name, arguments: args });
  return { out, handle, rpc, callTool };
}

describe("sql-execute MCP protocol", () => {
  it("lists exactly the sql_execute tool with a query-required schema", async () => {
    const { rpc } = harness(fakePool().pool);
    const r = await rpc("tools/list");
    expect(r.result.tools).toEqual([SQL_TOOL]);
    expect(SQL_TOOL.name).toBe("sql_execute");
    expect(SQL_TOOL.inputSchema.required).toEqual(["query"]);
  });

  it("answers initialize and ping, and stays quiet on notifications", async () => {
    const { rpc, out, handle } = harness(fakePool().pool);
    const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} } });
    expect((await rpc("ping")).result).toEqual({});
    out.length = 0;
    await handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }));
    await handle("   ");
    expect(out).toEqual([]);
  });

  it("maps protocol errors to JSON-RPC codes", async () => {
    const { rpc, out, handle } = harness(fakePool().pool);
    expect((await rpc("resources/list")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "drop_everything", arguments: {} })).error).toMatchObject({
      code: -32601,
      message: "Unknown tool: drop_everything",
    });
    out.length = 0;
    await handle("{not json");
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } });
    out.length = 0;
    await handle("[1,2]");
    expect(out[0]).toMatchObject({ id: null, error: { code: -32600 } });
  });
});

describe("sql_execute arguments", () => {
  it.each([
    [{}, /must not be empty/],
    [{ query: "   " }, /must not be empty/],
    [{ query: 42 }, /must not be empty/],
    [{ query: "DELETE FROM users" }, /Only SELECT/],
    [{ query: "update t set x=1" }, /Only SELECT/],
    [{ query: "selectx from t" }, /Only SELECT/],
    [{ query: "select 1", params: "1" }, /params must be an array/],
  ])("rejects %j before touching the database", async (args, re) => {
    const f = fakePool();
    const r = await harness(f.pool).callTool(args);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(re);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("treats non-object arguments as empty", async () => {
    const r = await harness(fakePool().pool).callTool(["select 1"]);
    expect(r.result.content[0].text).toMatch(/must not be empty/);
  });
});

describe("sql_execute execution", () => {
  it("runs one extended-protocol statement inside a rolled-back READ ONLY transaction", async () => {
    const f = fakePool({ rows: [{ id: 1 }], fields: ["id"] });
    const r = await harness(f.pool).callTool({ query: "select id from t where id = $1", params: [1] });
    expect(r.result.isError).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text)).toEqual({ rows: [{ id: 1 }], rowCount: 1, fields: ["id"] });
    expect(f.calls).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      { text: "select id from t where id = $1", values: [1], queryMode: "extended" },
      "ROLLBACK",
    ]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("accepts WITH, EXPLAIN and SHOW", async () => {
    for (const query of ["with x as (select 1) select * from x", "EXPLAIN select 1", "show search_path"]) {
      const r = await harness(fakePool().pool).callTool({ query });
      expect(r.result.isError, query).toBeUndefined();
    }
  });

  it(`caps results at ${MAX_ROWS} rows and says so`, async () => {
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ i }));
    const r = await harness(fakePool({ rows, fields: ["i"] }).pool).callTool({ query: "select i from t" });
    const body = JSON.parse(r.result.content[0].text);
    expect(body.rows).toHaveLength(MAX_ROWS);
    expect(body.truncated).toBe(true);
    expect(body.note).toBe(`Showing first ${MAX_ROWS} of ${MAX_ROWS + 5} rows.`);
  });

  it("returns bad SQL as a tool error, still rolls back and releases", async () => {
    const f = fakePool({ fail: new Error('syntax error at or near "form"') });
    const r = await harness(f.pool).callTool({ query: "select * form t" });
    expect(r.result).toMatchObject({ isError: true });
    expect(r.result.content[0].text).toBe('Error: syntax error at or near "form"');
    expect(f.calls.at(-1)).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("surfaces a write the prefix check missed as the read-only error", async () => {
    const f = fakePool({ fail: new Error("cannot execute DELETE in a read-only transaction") });
    const r = await harness(f.pool).callTool({ query: "with d as (delete from t returning *) select * from d" });
    expect(r.result.content[0].text).toMatch(/read-only transaction/);
  });
});

describe("secret never reaches tool output", () => {
  it("redacts the URL and password from database errors", async () => {
    const f = fakePool({ fail: new Error(`boom ${URL_} and again ${PASSWORD}`) });
    const r = await harness(f.pool).callTool({ query: "select 1" });
    const text = JSON.stringify(r);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(encodeURIComponent(PASSWORD));
    expect(text).not.toContain(URL_);
    expect(text).toContain("[redacted]");
  });

  it("redacts connection failures", async () => {
    const f = fakePool({ connectFail: new Error(`password authentication failed: ${PASSWORD}`) });
    const r = await harness(f.pool).callTool({ query: "select 1" });
    expect(r.result.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });

  it("redacts any credentialed postgres URL, not just ours", () => {
    expect(redactSecret("x postgres://u:other@h/db y", URL_)).toBe("x postgres://[redacted]@h/db y");
    expect(redactSecret("plain message", URL_)).toBe("plain message");
    expect(redactSecret(`a ${URL_} b`, "not a url")).toContain("[redacted]");
  });

  it("never puts the URL in list or initialize replies", async () => {
    const { rpc } = harness(fakePool().pool);
    for (const m of ["initialize", "tools/list", "ping"]) {
      const text = JSON.stringify(await rpc(m));
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("supabase.co");
    }
  });
});

describe("stdio entry point", () => {
  const entry = fileURLToPath(new URL("./sql-execute.ts", import.meta.url));
  const tsx = createRequire(import.meta.url).resolve("tsx");

  function run(env: Record<string, string>, input: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, entry], {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => {
        stdout += b;
        // Close stdin once every request has an answer.
        if (stdout.trim().split("\n").length >= input.length) child.stdin.end();
      });
      child.stderr.on("data", (b) => (stderr += b));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
      for (const line of input) child.stdin.write(line + "\n");
      if (!input.length) child.stdin.end();
    });
  }

  it("exits 1 without DATABASE_URL", async () => {
    const r = await run({}, []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is not set");
  }, 20_000);

  it("speaks JSON-RPC on stdout and redacts a real connection failure", async () => {
    // Port 1 on loopback refuses at once; no database is involved.
    const dbUrl = `postgres://agent:${PASSWORD}@127.0.0.1:1/app`;
    const r = await run({ DATABASE_URL: dbUrl }, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sql_execute", arguments: { query: "select 1" } } }),
    ]);
    const replies = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(replies.find((x) => x.id === 1).result.tools[0].name).toBe("sql_execute");
    const call = replies.find((x) => x.id === 2);
    expect(call.result.isError).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(PASSWORD);
    expect(r.stdout + r.stderr).not.toContain(dbUrl);
  }, 20_000);
});
