import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSession, PublicSessionDetail, PublicSessionListItem, PublicSessionSummary, PendingApproval, ToolCallRecord } from "../types.js";

/** Cap for persisted tool rawInput/content JSON (chars). */
export const MAX_TOOL_BLOB_CHARS = 4000;

/** Keep tool payloads on disk, but bound a rogue Bash dump so session JSON stays small. */
export function capToolBlob(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (serialized.length <= MAX_TOOL_BLOB_CHARS) return value;
    return { _truncated: true, preview: serialized.slice(0, MAX_TOOL_BLOB_CHARS) };
  } catch {
    return undefined;
  }
}

export function toolBlobToJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export class SessionStore {
  constructor(private readonly dataDir: string) {
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.dataDir, "sessions", `${id}.json`);
  }

  save(session: DispatchSession): void {
    // Keep disk small so list/detail stay fast on the phone
    const slim = slimSession(session);
    writeFileSync(this.pathFor(session.id), JSON.stringify(slim, null, 2) + "\n", "utf8");
  }

  load(id: string): DispatchSession | null {
    const p = this.pathFor(id);
    if (!existsSync(p)) return null;
    try {
      return slimSession(JSON.parse(readFileSync(p, "utf8")) as DispatchSession);
    } catch {
      return null;
    }
  }

  list(): DispatchSession[] {
    const dir = join(this.dataDir, "sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return slimSession(JSON.parse(readFileSync(join(dir, f), "utf8")) as DispatchSession);
        } catch {
          return null;
        }
      })
      .filter((s): s is DispatchSession => s !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  toSummary(s: DispatchSession, isLive = false): PublicSessionSummary {
    // Scan from the end — avoids spreading and reversing up to 120 entries per session.
    let lastAssistant: (typeof s.transcript)[number] | undefined;
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      const t = s.transcript[i]!;
      if (t.role === "assistant") { lastAssistant = t; break; }
    }
    return {
      id: s.id,
      grokSessionId: s.grokSessionId,
      grokHomeLabel: s.grokHomeLabel,
      title: s.title,
      prompt: s.prompt,
      cwd: s.cwd,
      projectId: s.projectId,
      model: s.model,
      planMode: s.planMode,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      completedAt: s.completedAt,
      error: s.error,
      pendingApprovalId: s.pendingApprovalId,
      toolCallCount: s.toolCalls.length,
      transcriptPreview: lastAssistant?.text?.slice(0, 240),
      isLive,
      archived: s.archived === true,
      archivedAt: s.archivedAt,
      backend: s.backend,
      botId: s.botId,
      profileId: s.profileId,
      profileName: s.profileName,
      profileColor: s.profileColor,
      claudeSessionId: s.claudeSessionId,
      antigravityConversationId: s.antigravityConversationId,
      creditsUsedDeltaPct: s.creditsUsedDeltaPct,
      creditsUsedAt: s.creditsUsedAt,
    };
  }

  toDetail(
    s: DispatchSession,
    pending?: PendingApproval | null,
    pendingQuestion?: import("../types.js").PendingQuestion | null,
  ): PublicSessionDetail {
    const slim = slimSession(s);
    return {
      ...this.toSummary(slim),
      subagents: slim.subagents,
      worktree: slim.worktree,
      stopReason: slim.stopReason,
      // Cap payload size for mobile — huge tool raw dumps cause 404/timeouts on phone
      transcript: slim.transcript.slice(-80),
      toolCalls: slim.toolCalls.slice(-60).map((t) => ({
        toolCallId: t.toolCallId,
        title: t.title,
        kind: t.kind,
        status: t.status,
        updatedAt: t.updatedAt,
        locations: t.locations,
        // RFC-040: small, so it rides along; rawInput/content stay off the wire.
        outputPreview: t.outputPreview,
        exitCode: t.exitCode,
      })),
      extraDirs: slim.extraDirs,
      plan: slim.plan,
      pendingApproval: pending ?? null,
      pendingQuestion: pendingQuestion ?? slim.pendingQuestion ?? null,
      tasks: slim.tasks,
      notes: slim.notes,
      usage: slim.usage,
    };
  }

  /**
   * RFC-069: slim shape for GET /sessions?view=summary.
   * Drops fields not rendered in any list view (error, completedAt, botId,
   * claudeSessionId, antigravityConversationId, pendingApprovalId,
   * grokSessionId) and caps prompt at 160 chars.
   */
  toListItem(s: DispatchSession, isLive = false): PublicSessionListItem {
    let transcriptPreview: string | undefined;
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      const t = s.transcript[i]!;
      if (t.role === "assistant" && t.text) { transcriptPreview = t.text.slice(0, 240); break; }
    }
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      model: s.model,
      cwd: s.cwd,
      projectId: s.projectId,
      planMode: s.planMode,
      archived: s.archived === true,
      archivedAt: s.archivedAt,
      isLive,
      backend: s.backend,
      profileId: s.profileId,
      profileName: s.profileName,
      profileColor: s.profileColor,
      grokHomeLabel: s.grokHomeLabel,
      transcriptPreview,
      prompt: s.prompt.slice(0, 160),
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      toolCallCount: s.toolCalls.length,
      creditsUsedDeltaPct: s.creditsUsedDeltaPct,
      creditsUsedAt: s.creditsUsedAt,
    };
  }
}

/**
 * RFC-069: page an already-sorted array using an opaque base64url cursor
 * (encodes the id of the last returned item).  Returns the page and the
 * next cursor (undefined when the caller has reached the end).
 */
export function pageItems<T extends { id: string }>(
  items: T[],
  limit: number,
  cursor: string | null,
): { page: T[]; nextCursor: string | undefined } {
  let start = 0;
  if (cursor) {
    try {
      const { id } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id: string };
      const idx = items.findIndex((s) => s.id === id);
      if (idx >= 0) start = idx + 1;
    } catch {
      // Ignore malformed cursor — start from the beginning.
    }
  }
  const page = items.slice(start, start + limit);
  const hasMore = start + limit < items.length;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(JSON.stringify({ id: page[page.length - 1]!.id })).toString("base64url")
      : undefined;
  return { page, nextCursor };
}

/**
 * RFC-069: compute a short ETag from the serialised response body.
 * Returns a quoted hex string (as required by RFC 7232 for strong ETags).
 */
export function computeSessionListETag(body: string): string {
  return `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
}

/** Drop bulky fields so session JSON stays phone-friendly. */
function slimSession(session: DispatchSession): DispatchSession {
  const events = (session.events ?? []).slice(-80);
  const transcript = (session.transcript ?? []).slice(-120);
  const toolCalls = (session.toolCalls ?? []).slice(-80).map((t): ToolCallRecord => ({
    toolCallId: t.toolCallId,
    title: (t.title ?? "Tool").slice(0, 200),
    kind: t.kind,
    status: t.status,
    updatedAt: t.updatedAt,
    locations: t.locations?.slice(0, 5),
    rawInput: capToolBlob(t.rawInput),
    content: capToolBlob(t.content),
    outputPreview: t.outputPreview,
    exitCode: t.exitCode,
  }));
  return {
    ...session,
    events,
    transcript,
    toolCalls,
    error: session.error?.slice(0, 2000),
  };
}
