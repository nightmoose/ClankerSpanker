import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  APPROVAL_HOOK_SOURCE,
  buildClaudeHookSettings,
  buildPreToolUseDecision,
  claudeChildEnv,
  claudeToolRestrictArgs,
  extraDirsForClaude,
  CLAUDE_PRETOOL_MATCHER,
  ClaudeRunner,
} from "./runner.js";
import { spawn } from "node:child_process";

describe("buildPreToolUseDecision", () => {
  it("emits Claude Code PreToolUse hookSpecificOutput shape", () => {
    expect(buildPreToolUseDecision("allow", "approved on phone")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "approved on phone",
      },
    });
  });

  it("supports deny with a reason for the model", () => {
    const body = buildPreToolUseDecision("deny", "rejected on phone");
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toBe("rejected on phone");
  });
});

describe("APPROVAL_HOOK_SOURCE", () => {
  it("does not use the flat decision/reason format Claude Code discards", () => {
    // Flat { decision, reason } is silently ignored (claude-code#48760).
    // Reject the old literals so a regression can't reintroduce them.
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/out\(\{\s*decision:/);
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/\{\s*decision:\s*"allow"/);
    expect(APPROVAL_HOOK_SOURCE).not.toMatch(/\{\s*decision:\s*"deny"/);
  });

  it("emits hookSpecificOutput.permissionDecision that Claude Code honors", () => {
    expect(APPROVAL_HOOK_SOURCE).toContain("hookSpecificOutput");
    expect(APPROVAL_HOOK_SOURCE).toContain('hookEventName: "PreToolUse"');
    expect(APPROVAL_HOOK_SOURCE).toContain("permissionDecision");
    expect(APPROVAL_HOOK_SOURCE).toContain("permissionDecisionReason");
    expect(APPROVAL_HOOK_SOURCE).toContain('decide("allow"');
    expect(APPROVAL_HOOK_SOURCE).toContain('decide("deny"');
  });

  it("exits 0 after JSON decisions so the payload is parsed (not exit-2 stderr path)", () => {
    // Exit 2 feeds stderr as a blocking error and can skip structured JSON.
    // All decision paths should process.exit(0) after decide(...).
    const decideThenExit = APPROVAL_HOOK_SOURCE.match(
      /decide\([^)]+\);\s*process\.exit\((\d+)\)/g,
    );
    expect(decideThenExit?.length).toBeGreaterThanOrEqual(4);
    for (const line of decideThenExit ?? []) {
      expect(line).toMatch(/process\.exit\(0\)/);
    }
  });
});

describe("buildClaudeHookSettings extra dirs", () => {
  it("matches MCP tools so they park on the phone bar instead of a TTY prompt", () => {
    const settings = buildClaudeHookSettings("/hooks/pretool.mjs");
    const pre = (settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse[0];
    expect(pre?.matcher).toBe(CLAUDE_PRETOOL_MATCHER);
    expect(pre?.matcher).toMatch(/mcp_/);
    expect("mcp_azure-devops_search_workItem").toMatch(new RegExp(pre!.matcher));
    expect("mcp__azure-devops__search_workItem").toMatch(new RegExp(pre!.matcher));
  });

  it("grants Read + additionalDirectories so screenshot attachments are not sandboxed", () => {
    const dir = "/tmp/cs-attachments";
    const settings = buildClaudeHookSettings("/hooks/pretool.mjs", [dir]);
    const perms = settings.permissions as {
      additionalDirectories: string[];
      allow: string[];
    };
    expect(perms.additionalDirectories).toEqual([dir]);
    expect(perms.allow).toEqual([`Read(${dir}/**)`]);
  });

  it("omits permissions when there are no extra dirs", () => {
    const settings = buildClaudeHookSettings("/hooks/pretool.mjs");
    expect(settings.permissions).toBeUndefined();
  });
});

describe("claudeToolRestrictArgs", () => {
  it("passes --tools when a pre-flight allowlist is set", () => {
    expect(claudeToolRestrictArgs(["Read", "Grep"])).toEqual(["--tools", "Read,Grep"]);
    expect(claudeToolRestrictArgs([])).toEqual([]);
    expect(claudeToolRestrictArgs(undefined)).toEqual([]);
  });
});

describe("extraDirsForClaude", () => {
  it("drops missing paths and dedupes", () => {
    const real = mkdtempSync(join(tmpdir(), "cs-extra-"));
    mkdirSync(real, { recursive: true });
    expect(extraDirsForClaude([real, real, "/no/such/dir-xyz", ""])).toEqual([real]);
  });
});

describe("phone approval channel", () => {
  const savedBinary = process.env.CLAUDE_BINARY;
  afterEach(() => {
    if (savedBinary === undefined) delete process.env.CLAUDE_BINARY;
    else process.env.CLAUDE_BINARY = savedBinary;
  });

  it("keeps the host token on the unsandboxed child and off the jailed child", () => {
    const open = claudeChildEnv({
      sandbox: false,
      dispatchSessionId: "s",
      hostBaseUrl: "http://127.0.0.1:8787",
      hostToken: "host-token-value",
      profileEnv: { PROFILE_ONLY: "yes" },
    });
    expect(open.CLAUDE_DISPATCH_TOKEN).toBe("host-token-value");
    expect(open.CLAUDE_DISPATCH_SESSION_ID).toBe("s");
    expect(open.CLAUDE_DISPATCH_HOST).toBe("http://127.0.0.1:8787");
    expect(open.PROFILE_ONLY).toBe("yes");

    const jailed = claudeChildEnv({
      sandbox: true,
      dispatchSessionId: "s",
      hostBaseUrl: "http://127.0.0.1:8787",
      hostToken: "host-token-value",
      profileEnv: { PROFILE_ONLY: "yes", CLAUDE_DISPATCH_TOKEN: "host-token-value" },
    });
    expect(jailed.CLAUDE_DISPATCH_TOKEN).toBeUndefined();
    expect(jailed.CLAUDE_DISPATCH_SESSION_ID).toBeUndefined();
    expect(jailed.CLAUDE_DISPATCH_HOST).toBeUndefined();
    expect(jailed.PROFILE_ONLY).toBe("yes");
  });

  it("leaves the unsandboxed hook command unchanged and adds a socket only when asked", () => {
    const plain = buildClaudeHookSettings("/hooks/pretool.mjs");
    const plainHooks = plain.hooks as { PreToolUse: { hooks: { command: string }[] }[] };
    expect(plainHooks.PreToolUse[0]?.hooks[0]?.command).toBe('node "/hooks/pretool.mjs"');

    const jailed = buildClaudeHookSettings("/hooks/pretool.mjs", [], {
      approvalSock: "/tmp/cs-approval.sock",
      nodeBin: "/usr/bin/node",
    });
    const jailedHooks = jailed.hooks as { PreToolUse: { hooks: { command: string }[] }[] };
    expect(jailedHooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      '"/usr/bin/node" "/hooks/pretool.mjs" "/tmp/cs-approval.sock"',
    );
  });

  it("uses the host token on the unsandboxed hook and the socket when a path is set", async () => {
    const hits: { authorization: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        hits.push({
          authorization: String(req.headers.authorization ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ approvalId: "ap-http" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "rejected", comment: "no" }));
      });
    });
    const url = await listen(server);
    try {
      const denied = await runHook([], {}, "{}");
      expect(decision(denied.stdout)).toBe("deny");
      expect(hits).toHaveLength(0);

      const http = await runHook(
        [],
        {
          CLAUDE_DISPATCH_SESSION_ID: "sess-http",
          CLAUDE_DISPATCH_HOST: url,
          CLAUDE_DISPATCH_TOKEN: "host-token-value",
        },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      );
      expect(decision(http.stdout), http.stderr).toBe("deny");
      expect(hits[0]?.authorization).toBe("Bearer host-token-value");
      expect(JSON.parse(hits[0]?.body ?? "{}").sessionId).toBe("sess-http");

      const { startApprovalBroker } = await import("../approval-broker.js");
      let seen = "";
      const broker = await startApprovalBroker({
        sessionId: "bound-session",
        async create(body) {
          seen = body.sessionId;
          return { approvalId: "ap-sock" };
        },
        async poll() {
          return { status: "approved", comment: "from the phone" };
        },
      });
      try {
        const before = hits.length;
        const sock = await runHook(
          [broker.socketPath],
          {
            CLAUDE_DISPATCH_SESSION_ID: "ignored",
            CLAUDE_DISPATCH_HOST: url,
            CLAUDE_DISPATCH_TOKEN: "host-token-value",
          },
          JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
        );
        expect(decision(sock.stdout), sock.stderr).toBe("allow");
        expect(sock.stdout).toContain("from the phone");
        expect(sock.stdout).not.toContain("host-token-value");
        expect(seen).toBe("bound-session");
        expect(hits).toHaveLength(before);
      } finally {
        broker.close();
      }

      const missing = await runHook(
        ["/tmp/cs-approval-does-not-exist.sock"],
        { CLAUDE_DISPATCH_TOKEN: "host-token-value", CLAUDE_DISPATCH_SESSION_ID: "s" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      );
      expect(decision(missing.stdout), missing.stderr).toBe("deny");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("still passes the host token to an unsandboxed child", async () => {
    const dir = fakeClaude(
      'printf "%s\\n" "TOKEN:${CLAUDE_DISPATCH_TOKEN-unset}"\nprintf "%s\\n" "ARGS:$*"\n',
    );
    const runner = new ClaudeRunner({
      cwd: dir,
      prompt: "hi",
      dispatchSessionId: "sess-open",
      hostBaseUrl: "http://127.0.0.1:9",
      hostToken: "host-token-value",
      dataDir: dir,
      requirePhoneApproval: true,
    });
    const result = await runner.run();
    expect(result.text).toContain("TOKEN:host-token-value");
    expect(result.text).not.toContain("cs-approval.sock");
  });

  it("asks for a phone decision from inside the jail without the host token", async () => {
    if (process.platform !== "linux") return;
    const hits: { authorization: string; body: string; url: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        hits.push({
          authorization: String(req.headers.authorization ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
          url: req.url ?? "",
        });
        if (req.method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ approvalId: "ap-jail" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "approved", comment: "from the phone" }));
      });
    });
    const url = await listen(server);
    const dir = fakeClaude(`#!/bin/sh
printf '%s\\n' "TOKEN:\${CLAUDE_DISPATCH_TOKEN-unset}"
printf '%s\\n' "SESSION:\${CLAUDE_DISPATCH_SESSION_ID-unset}"
settings=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--settings" ]; then settings=$a; fi
  prev=$a
done
if [ -n "$settings" ] && grep -q '/tmp/cs-approval.sock' "$settings"; then
  printf '%s\\n' "SETTINGS_SOCK:yes"
else
  printf '%s\\n' "SETTINGS_SOCK:no"
fi
if [ -n "$settings" ] && grep -q CLAUDE_DISPATCH_TOKEN "$settings"; then
  printf '%s\\n' "SETTINGS_TOKEN_KEY:yes"
else
  printf '%s\\n' "SETTINGS_TOKEN_KEY:no"
fi
python3 -c 'import socket,json,sys
s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/tmp/cs-approval.sock")
s.sendall(json.dumps({"op":"create","toolName":"Bash","title":"t","toolInput":{"command":"ls"},"sessionId":"attacker","token":"client-supplied"}).encode()+b"\\n")
s.shutdown(socket.SHUT_WR)
sys.stdout.write("BROKER:"+s.recv(4096).decode()+"\\n")
'
`);
    const runner = new ClaudeRunner({
      cwd: dir,
      prompt: "hi",
      dispatchSessionId: "bound-session",
      hostBaseUrl: url,
      hostToken: "host-token-value",
      dataDir: dir,
      requirePhoneApproval: true,
      sandbox: true,
    });
    try {
      const result = await runner.run();
      expect(result.text).toContain("TOKEN:unset");
      expect(result.text).toContain("SESSION:unset");
      expect(result.text).toContain("SETTINGS_SOCK:yes");
      expect(result.text).toContain("SETTINGS_TOKEN_KEY:no");
      expect(result.text).toContain("BROKER:");
      expect(result.text).not.toContain("host-token-value");
      expect(hits.some((h) => h.authorization === "Bearer host-token-value")).toBe(true);
      const posted = hits.find((h) => h.url === "/internal/claude-approval");
      expect(JSON.parse(posted?.body ?? "{}").sessionId).toBe("bound-session");
      expect(posted?.body).not.toContain("client-supplied");
      expect(posted?.body).not.toContain("attacker");
    } finally {
      runner.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function decision(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } };
  return parsed.hookSpecificOutput.permissionDecision;
}

function runHook(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const dir = mkdtempSync(join(tmpdir(), "cs-hook-"));
  const file = join(dir, "hook.mjs");
  writeFileSync(file, APPROVAL_HOOK_SOURCE);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [file, ...args], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_APPROVAL_POLL_MS: "0", ...env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
    });
    proc.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.stdin.end(stdin);
  });
}

function fakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, script.startsWith("#!") ? script : `#!/bin/sh\n${script}`);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BINARY = bin;
  return dir;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
