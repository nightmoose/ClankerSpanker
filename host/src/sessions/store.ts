import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchSession, PublicSessionDetail, PublicSessionSummary, PendingApproval } from "../types.js";

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
    const lastAssistant = [...s.transcript].reverse().find((t) => t.role === "assistant");
    return {
      id: s.id,
      grokSessionId: s.grokSessionId,
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
        // drop rawInput/content from wire response
      })),
      plan: slim.plan,
      pendingApproval: pending ?? null,
      pendingQuestion: pendingQuestion ?? slim.pendingQuestion ?? null,
    };
  }
}

/** Drop bulky fields so session JSON stays phone-friendly. */
function slimSession(session: DispatchSession): DispatchSession {
  const events = (session.events ?? []).slice(-80);
  const transcript = (session.transcript ?? []).slice(-120);
  const toolCalls = (session.toolCalls ?? []).slice(-80).map((t) => ({
    toolCallId: t.toolCallId,
    title: (t.title ?? "Tool").slice(0, 200),
    kind: t.kind,
    status: t.status,
    updatedAt: t.updatedAt,
    locations: t.locations?.slice(0, 5),
    // omit rawInput / content blobs
  }));
  return {
    ...session,
    events,
    transcript,
    toolCalls,
    error: session.error?.slice(0, 2000),
  };
}
