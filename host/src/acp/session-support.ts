// Extracted from session-manager.ts (RFC-051 phase A). Behavior unchanged.
import { randomUUID } from "node:crypto";
import type { HostConfigFile } from "../types.js";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AgentQuestion, DispatchSession, PendingQuestion, ProjectAttachment, PromptImage } from "../types.js";
import { saveConfig } from "../config.js";
import { isMcpOAuthRequiredMessage, mcpOAuthRequiredHost } from "../login.js";
import { now } from "./session-helpers.js";

/** Normalize ACP extension method names (`_x.ai/…` → `x.ai/…`). */
export function normalizeAcpMethod(method: string): string {
  if (method.startsWith("_x.ai/")) return "x.ai/" + method.slice("_x.ai/".length);
  if (method.startsWith("_")) {
    // Generic leading underscore used by some agent builds for extensions
    const rest = method.slice(1);
    if (rest.startsWith("x.ai/")) return rest;
  }
  return method;
}

export function mapAgentExitError(detail: string | undefined | null): string | null {
  if (!detail) return null;
  const lower = detail.toLowerCase();
  // MCP connector OAuth (Vercel, Gmail, …) — not NightMoose / Grok CLI login.
  if (isMcpOAuthRequiredMessage(detail)) {
    const host = mcpOAuthRequiredHost(detail);
    const where = host ? ` (${host})` : "";
    return (
      `MCP connector needs Sign in${where}. Open Host → Profiles on this Mac ` +
      `and Sign in for that server, then send another message. ` +
      `This is not a NightMoose / Grok login.`
    );
  }
  // Nested worker noise often says AuthorizationRequired even while the main
  // session is healthy. Only map to a hard auth message when it looks terminal.
  if (
    lower.includes("authorizationrequired") ||
    lower.includes("auth(authorizationrequired)")
  ) {
    if (lower.includes("worker quit") || lower.includes("transport channel closed")) {
      return (
        "Grok agent worker disconnected (auth/transport). " +
        "Usually transient — reopen the chat to continue. " +
        "If every new session fails immediately, run `grok login` on the Mac."
      );
    }
    return (
      "Grok auth issue on the host (AuthorizationRequired). " +
      "If new sessions fail, run `grok login` on the Mac."
    );
  }
  return null;
}

export function rawIsExitPlan(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && (raw as { variant?: string }).variant === "ExitPlanMode");
}

/** True when this approval was parked from `_x.ai/exit_plan_mode` (native verdict). */
export function isGrokExitPlanApproval(approval: {
  source?: "grok" | "claude";
  rawInput?: unknown;
}): boolean {
  return approval.source === "grok" && rawIsExitPlan(approval.rawInput);
}

export function findClaudeTranscriptPath(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return undefined;
  for (const proj of readdirSync(root)) {
    const p = join(root, proj, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function normalizeQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      if (!q || typeof q !== "object") return null;
      const o = q as Record<string, unknown>;
      const question = String(o.question ?? o.prompt ?? "").trim();
      if (!question) return null;
      const optionsRaw = Array.isArray(o.options) ? o.options : [];
      const options = optionsRaw
        .map((opt) => {
          if (typeof opt === "string") return { label: opt };
          if (!opt || typeof opt !== "object") return null;
          const oo = opt as Record<string, unknown>;
          const label = String(oo.label ?? oo.name ?? oo.id ?? "").trim();
          if (!label) return null;
          return {
            label,
            description: oo.description != null ? String(oo.description) : undefined,
            preview: oo.preview != null ? String(oo.preview) : undefined,
          };
        })
        .filter((x): x is { label: string; description?: string; preview?: string } => x !== null);
      return {
        question,
        options,
        multiSelect: Boolean(o.multiSelect ?? o.multi_select),
      } as AgentQuestion;
    })
    .filter((x): x is AgentQuestion => x !== null);
}

export function extractQuestionsFromUnknown(params: unknown): AgentQuestion[] {
  if (!params || typeof params !== "object") return [];
  const p = params as Record<string, unknown>;
  if (Array.isArray(p.questions)) return normalizeQuestions(p.questions);
  const ri = p.rawInput as Record<string, unknown> | undefined;
  if (ri && Array.isArray(ri.questions)) return normalizeQuestions(ri.questions);
  const tc = p.toolCall as Record<string, unknown> | undefined;
  if (tc) {
    const tri = tc.rawInput as Record<string, unknown> | undefined;
    if (tri && Array.isArray(tri.questions)) return normalizeQuestions(tri.questions);
  }
  return [];
}

export function findPendingAskUserTool(s: DispatchSession): PendingQuestion | null {
  for (const t of [...(s.toolCalls ?? [])].reverse()) {
    const ri = t.rawInput as { variant?: string; questions?: unknown } | undefined;
    if (ri?.variant !== "AskUserQuestion") continue;
    if (t.status === "completed" || t.status === "failed") continue;
    const questions = normalizeQuestions(ri.questions);
    if (!questions.length) continue;
    return {
      id: `tool-${t.toolCallId}`,
      sessionId: s.id,
      toolCallId: t.toolCallId,
      title: t.title || "Grok has questions",
      questions,
      createdAt: t.updatedAt || now(),
      canRespondViaAcp: false,
    };
  }
  return null;
}

export const MAX_PROMPT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 3_500_000; // ~decoded size cap per image

export function normalizeImages(images?: PromptImage[]): PromptImage[] {
  if (!images?.length) return [];
  const out: PromptImage[] = [];
  for (const img of images.slice(0, MAX_PROMPT_IMAGES)) {
    if (!img?.data || !img.mimeType) continue;
    const mime = String(img.mimeType).toLowerCase();
    if (!mime.startsWith("image/")) continue;
    // Strip accidental data-URL prefix
    let data = String(img.data).trim();
    const comma = data.indexOf(",");
    if (data.startsWith("data:") && comma >= 0) data = data.slice(comma + 1);
    const approxBytes = Math.floor((data.length * 3) / 4);
    if (approxBytes <= 0 || approxBytes > MAX_IMAGE_BYTES) continue;
    out.push({
      mimeType: mime === "image/jpg" ? "image/jpeg" : mime,
      data,
      name: img.name,
    });
  }
  return out;
}

/**
 * Save prompt attachments to disk. If the session belongs to a project,
 * route the file into the project's attachments dir and register it under
 * `project.attachments` (with `fromSessionId`) so it becomes reusable
 * context across every session in the project — the whole point of the
 * project-scoped attachment model. Falls back to session-scoped storage
 * when there's no project.
 */
export function ensureAttachmentDirs(config: HostConfigFile, session: DispatchSession): string[] {
  const dirs = [join(config.dataDir, "sessions", session.id, "attachments")];
  if (session.projectId) {
    dirs.push(join(config.dataDir, "projects", session.projectId, "attachments"));
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  for (const extra of session.extraDirs ?? []) {
    if (extra && !dirs.includes(extra)) dirs.push(extra);
  }
  return dirs;
}

/**
 * Copy host-saved screenshots into the session cwd so Claude Code can Read
 * them without a sandbox permission prompt. Files under ~/.grok-dispatch are
 * outside the project, which is what produced "Read is blocked on that
 * directory" after the user attached screenshots.
 */
export function materializeImagesInCwd(cwd: string, sourcePaths: string[]): string[] {
  if (!sourcePaths.length) return [];
  try {
    const dir = join(cwd, ".clankerspanker-attachments");
    mkdirSync(dir, { recursive: true });
    const gi = join(dir, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n!.gitignore\n");
    const out: string[] = [];
    for (const src of sourcePaths) {
      const dest = join(dir, basename(src));
      copyFileSync(src, dest);
      out.push(dest);
    }
    return out;
  } catch (err) {
    console.warn("[attachments] cwd copy failed, using host dataDir paths:", err);
    return sourcePaths;
  }
}

export function savePromptImages(dataDir: string, sessionId: string, images: PromptImage[]): string[] {
  if (!images.length) return [];
  const dir = join(dataDir, "sessions", sessionId, "attachments");
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext =
      img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
    const file = join(dir, `${randomUUID()}.${ext}`);
    try {
      writeFileSync(file, Buffer.from(img.data, "base64"));
      paths.push(file);
    } catch (err) {
      console.warn("[attachments] failed to save image:", err);
    }
  }
  return paths;
}

/**
 * Manager-level variant: save each image both to the session's dir (for
 * Claude's path-based prompt injection) AND, if the session has a
 * projectId, into the project's attachments store so it's reusable.
 * Returns the session-scoped disk paths (what the agents actually use).
 */
export function savePromptImagesForSession(
  config: HostConfigFile,
  session: DispatchSession,
  images: PromptImage[],
): string[] {
  const paths = savePromptImages(config.dataDir, session.id, images);
  if (!images.length || !session.projectId) return paths;
  const project = (config.projects ?? []).find((p) => p.id === session.projectId);
  if (!project || project.archived) return paths;

  const projectDir = join(config.dataDir, "projects", project.id, "attachments");
  mkdirSync(projectDir, { recursive: true });
  const newAttachments: ProjectAttachment[] = [];
  for (const img of images) {
    const ext =
      img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg";
    const attachmentId = randomUUID();
    const filename = `${attachmentId}.${ext}`;
    try {
      const bytes = Buffer.from(img.data, "base64");
      writeFileSync(join(projectDir, filename), bytes);
      newAttachments.push({
        id: attachmentId,
        filename,
        originalName: img.name,
        mimeType: img.mimeType,
        sizeBytes: bytes.length,
        addedAt: now(),
        fromSessionId: session.id,
      });
    } catch (err) {
      console.warn("[attachments] failed to copy image into project:", err);
    }
  }
  if (newAttachments.length > 0) {
    project.attachments = [...(project.attachments ?? []), ...newAttachments];
    project.updatedAt = now();
    // Fire-and-forget: saveConfig failure is non-fatal (already logged inside).
    saveConfig(config);
  }
  return paths;
}
