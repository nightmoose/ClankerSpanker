/**
 * Read-only demo for the browser control plane (RFC-067).
 *
 * Canned answers in the shape the gateway API returns, so a visitor with no
 * gateway can see the product. `demoApi` stands in for `api()` in app.js:
 * it never calls fetch or opens a socket, never sees a token, and refuses
 * every request that would change something.
 */

const AT = "2026-10-20T15:42:00.000Z";

const PROJECTS = [
  { id: "storefront", name: "storefront", path: "/Users/demo/Projects/storefront" },
  { id: "billing-api", name: "billing-api", path: "/Users/demo/Projects/billing-api" },
  { id: "mobile", name: "mobile", path: "/Users/demo/Projects/mobile" },
];

const PROFILES = [
  { id: "grok", name: "Grok", backend: "grok", color: "#73B8FF", model: "grok-code-fast-1", hasCredentials: true },
  { id: "claude-work", name: "Claude (work)", backend: "claude", color: "#F97316", model: "claude-sonnet-5-5", hasCredentials: true },
  { id: "claude-personal", name: "Claude (personal)", backend: "claude", color: "#FB923C", hasCredentials: true },
  { id: "gemini", name: "Gemini", backend: "antigravity", color: "#34A853", hasCredentials: false },
];

function entry(id, role, text) {
  return { id, role, text, at: AT };
}

function tool(toolCallId, title, status, extra = {}) {
  return { toolCallId, title, status, updatedAt: AT, ...extra };
}

const DETAILS = [
  {
    id: "demo-checkout",
    backend: "claude",
    profileId: "claude-work",
    projectId: "storefront",
    title: "Fix the flaky checkout test",
    prompt: "checkout.spec.ts fails about one run in five on CI. Find out why and fix it.",
    cwd: "/Users/demo/Projects/storefront",
    model: "claude-sonnet-5-5",
    status: "awaiting_approval",
    transcriptPreview: "The test reads the cart total before the discount request resolves.",
    transcript: [
      entry("t1", "user", "checkout.spec.ts fails about one run in five on CI. Find out why and fix it."),
      entry("t2", "assistant", "I'll run the spec a few times and read the checkout flow."),
      entry(
        "t3",
        "assistant",
        "Found it. The test reads the cart total before the discount request resolves, so it sees the pre-discount price when the API is slow. " +
          "I'd like to wait for the total to update instead of reading it straight after the click.",
      ),
    ],
    toolCalls: [
      tool("c1", "Read src/checkout/Cart.tsx", "completed"),
      tool("c2", "npx vitest run checkout.spec.ts --repeat 10", "completed", {
        exitCode: 1,
        outputPreview:
          " ✓ checkout.spec.ts (8 runs)\n × checkout.spec.ts > applies the promo code (2 runs)\n   Expected: \"$40.50\"\n   Received: \"$45.00\"\n\nTests  2 failed | 8 passed (10)",
      }),
      tool("c3", "Read tests/checkout.spec.ts", "completed"),
      tool("c4", "Edit tests/checkout.spec.ts", "pending"),
    ],
    pendingApproval: {
      id: "demo-approval",
      sessionId: "demo-checkout",
      title: "Edit tests/checkout.spec.ts",
      kind: "edit",
      preview: {
        type: "diff",
        path: "/Users/demo/Projects/storefront/tests/checkout.spec.ts",
        oldText: '  await page.click("text=Apply");\n  expect(await total.textContent()).toBe("$40.50");',
        newText: '  await page.click("text=Apply");\n  await expect(total).toHaveText("$40.50");',
        truncated: false,
      },
      options: [],
      createdAt: AT,
    },
    pendingQuestion: null,
  },
  {
    id: "demo-ratelimit",
    backend: "grok",
    profileId: "grok",
    projectId: "billing-api",
    title: "Rate-limit POST /login",
    prompt: "Add a per-IP rate limit to POST /login: 5 attempts a minute, 429 after that, with a test.",
    cwd: "/Users/demo/Projects/billing-api",
    model: "grok-code-fast-1",
    status: "running",
    creditsUsedDeltaPct: 3.4,
    transcriptPreview: "Adding a sliding-window limiter in middleware/rate-limit.ts.",
    transcript: [
      entry("r1", "user", "Add a per-IP rate limit to POST /login: 5 attempts a minute, 429 after that, with a test."),
      entry("r2", "assistant", "The app already uses Redis for sessions, so I'll use a sliding window keyed by IP there."),
      entry("r3", "assistant", "Adding a sliding-window limiter in middleware/rate-limit.ts."),
    ],
    toolCalls: [
      tool("g1", "Read src/routes/auth.ts", "completed"),
      tool("g2", "Write src/middleware/rate-limit.ts", "completed"),
      tool("g3", "npm test -- auth", "in_progress"),
    ],
    pendingApproval: null,
    pendingQuestion: null,
  },
  {
    id: "demo-migration",
    backend: "claude",
    profileId: "claude-personal",
    projectId: "billing-api",
    title: "Invoices table migration",
    prompt: "Write the migration that adds a currency column to invoices.",
    cwd: "/Users/demo/Projects/billing-api",
    model: "claude-sonnet-5-5",
    status: "awaiting_question",
    transcriptPreview: "Two choices before I write it.",
    transcript: [
      entry("m1", "user", "Write the migration that adds a currency column to invoices."),
      entry("m2", "assistant", "There are 1.2M existing invoices. Two choices before I write it."),
    ],
    toolCalls: [tool("q1", "psql -c \"select count(*) from invoices\"", "completed", { outputPreview: " count\n---------\n 1204317" })],
    pendingApproval: null,
    pendingQuestion: {
      id: "demo-question",
      sessionId: "demo-migration",
      title: "Before I write the migration",
      questions: [
        {
          question: "What should existing rows get?",
          options: [{ label: "USD for every existing row" }, { label: "Derive it from the customer's country" }],
        },
        {
          question: "How should it run?",
          options: [{ label: "One transaction" }, { label: "Batches of 10,000 rows" }],
        },
      ],
      createdAt: AT,
    },
  },
  {
    id: "demo-deps",
    backend: "grok",
    profileId: "grok",
    projectId: "mobile",
    title: "Bump dependencies, fix type errors",
    prompt: "Update everything in package.json to latest minor and fix whatever breaks.",
    cwd: "/Users/demo/Projects/mobile",
    model: "grok-code-fast-1",
    status: "idle",
    creditsUsedDeltaPct: 7.2,
    transcriptPreview: "Done: 14 packages updated, 3 type errors fixed, tests green.",
    transcript: [
      entry("d1", "user", "Update everything in package.json to latest minor and fix whatever breaks."),
      entry("d2", "assistant", "Done: 14 packages updated, 3 type errors fixed, tests green. The diff is on branch deps/2026-10-20."),
    ],
    toolCalls: [
      tool("p1", "npm outdated", "completed"),
      tool("p2", "npm install", "completed"),
      tool("p3", "npx tsc --noEmit", "completed", { exitCode: 0, outputPreview: "" }),
      tool("p4", "npm test", "completed", { exitCode: 0, outputPreview: "Tests  212 passed (212)" }),
    ],
    pendingApproval: null,
    pendingQuestion: null,
  },
];

const ARCHIVED = [
  {
    id: "demo-readme",
    backend: "claude",
    profileId: "claude-work",
    projectId: "storefront",
    title: "Rewrite the README quickstart",
    prompt: "The quickstart is out of date. Rewrite it.",
    cwd: "/Users/demo/Projects/storefront",
    model: "claude-sonnet-5-5",
    status: "completed",
    archived: true,
    transcriptPreview: "Rewrote the quickstart around `npm create` and checked every command.",
    transcript: [
      entry("a1", "user", "The quickstart is out of date. Rewrite it."),
      entry("a2", "assistant", "Rewrote the quickstart around `npm create` and checked every command."),
    ],
    toolCalls: [],
    pendingApproval: null,
    pendingQuestion: null,
  },
];

const DISK_GROK = [
  { id: "9f3c2a1e-grok-disk-1", title: "Profile the image resizer", cwd: "/Users/demo/Projects/mobile" },
  { id: "4b7e9d20-grok-disk-2", title: "Split the orders controller", cwd: "/Users/demo/Projects/billing-api" },
];

const DISK_CLAUDE = [
  { id: "c81d4e55-claude-disk-1", title: "Accessibility pass on checkout", cwd: "/Users/demo/Projects/storefront" },
  { id: "e02a6f13-claude-disk-2", title: "Explain the webhook retry logic", cwd: "/Users/demo/Projects/billing-api" },
];

function summary(d) {
  const { transcript: _t, toolCalls: _c, pendingApproval: _a, pendingQuestion: _q, ...rest } = d;
  return rest;
}

/** Copies, so the UI can never change the canned data. */
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function demoSessionIds() {
  return [...DETAILS, ...ARCHIVED].map((d) => d.id);
}

export const DEMO_NOTICE = "This is the demo, so nothing happens.";

/** What the gateway would have done, for the banner a demo action shows. */
function readOnlyMessage(path) {
  const what = [
    [/\/approve$/, "Approve lets the agent make this edit"],
    [/\/reject$/, "Reject stops the edit and tells the agent why"],
    [/\/answer-questions$/, "your answers go back to the agent"],
    [/\/prompt$/, "this message goes to the agent"],
    [/\/cancel$/, "Cancel stops the agent"],
    [/\/(un)?archive$/, "this moves the chat"],
    [/^\/dispatch$/, "this starts an agent in the project folder"],
    [/^\/sessions\/attach/, "this resumes that session from disk"],
  ].find(([re]) => re.test(path));
  const tail = what ? ` On your own gateway, ${what[1]}.` : "";
  return `${DEMO_NOTICE}${tail} Connect your gateway to do it for real.`;
}

export class DemoReadOnlyError extends Error {
  constructor(path) {
    super(readOnlyMessage(path));
    this.name = "DemoReadOnlyError";
  }
}

/**
 * The demo stand-in for `api(path, opts)`. Resolves to the same body the
 * gateway would for the read routes the UI uses; rejects with
 * DemoReadOnlyError for anything else.
 */
export async function demoApi(path, opts = {}) {
  const method = String(opts.method || "GET").toUpperCase();
  const url = new URL(path, "https://demo.invalid/");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (method !== "GET") throw new DemoReadOnlyError(p);

  if (p === "/sessions") {
    return clone({
      sessions: DETAILS.map(summary),
      archivedSessions: ARCHIVED.map(summary),
      diskSessions: DISK_GROK,
      claudeSessions: DISK_CLAUDE,
    });
  }
  if (p === "/projects") return clone({ projects: PROJECTS });
  if (p === "/profiles") return clone({ profiles: PROFILES, admin: false, adminProfiles: [] });
  if (p === "/mcp/catalog") return { servers: [], assignments: {} };
  if (p === "/bots") return { bots: [] };
  const m = p.match(/^\/sessions\/([^/]+)$/);
  if (m) {
    const d = [...DETAILS, ...ARCHIVED].find((x) => x.id === decodeURIComponent(m[1]));
    if (d) return clone(d);
    throw new Error("No such session in the demo.");
  }
  throw new DemoReadOnlyError(p);
}
