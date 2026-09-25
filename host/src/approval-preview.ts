/**
 * What an approval will actually do, normalized for every client (RFC-033).
 *
 * Approval cards only rendered outbound-message fields (to / body / reason),
 * so Grok edits (`old_string` / `new_string`), Claude edits and shell commands
 * showed an empty box — the one thing you need to decide was missing.
 */
export type ApprovalPreview =
  | { type: "diff"; path?: string; oldText: string; newText: string; truncated: boolean }
  | { type: "command"; command: string; cwd?: string; truncated: boolean };

export const PREVIEW_MAX_CHARS = 8_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > PREVIEW_MAX_CHARS
    ? { text: text.slice(0, PREVIEW_MAX_CHARS), truncated: true }
    : { text, truncated: false };
}

function diff(path: string | undefined, oldText: string, newText: string): ApprovalPreview {
  const o = cap(oldText);
  const n = cap(newText);
  return { type: "diff", path, oldText: o.text, newText: n.text, truncated: o.truncated || n.truncated };
}

/**
 * Build a preview from an ACP tool call (`content[]` diff blocks) and/or the
 * tool's raw input (Grok SearchReplace, Claude Edit / MultiEdit / Write, Bash).
 */
export function approvalPreview(rawInput: unknown, toolContent?: unknown): ApprovalPreview | undefined {
  if (Array.isArray(toolContent)) {
    const blocks = toolContent.filter(
      (c): c is Record<string, unknown> => !!c && typeof c === "object" && (c as { type?: unknown }).type === "diff",
    );
    if (blocks.length) {
      const path = str(blocks[0]!.path);
      return diff(
        path,
        blocks.map((b) => str(b.oldText) ?? "").join("\n…\n"),
        blocks.map((b) => str(b.newText) ?? "").join("\n…\n"),
      );
    }
  }

  if (!rawInput || typeof rawInput !== "object") return undefined;
  const r = rawInput as Record<string, unknown>;
  const path = str(r.file_path) ?? str(r.path) ?? str(r.notebook_path);

  const command = str(r.command) ?? str(r.cmd);
  if (command) {
    const c = cap(command);
    return { type: "command", command: c.text, cwd: str(r.cwd) ?? str(r.workdir), truncated: c.truncated };
  }

  const oldS = str(r.old_string);
  const newS = str(r.new_string);
  if (oldS !== undefined || newS !== undefined) return diff(path, oldS ?? "", newS ?? "");

  if (Array.isArray(r.edits)) {
    const edits = r.edits.filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
    if (edits.length) {
      return diff(
        path,
        edits.map((e) => str(e.old_string) ?? "").join("\n…\n"),
        edits.map((e) => str(e.new_string) ?? "").join("\n…\n"),
      );
    }
  }

  // Write: whole new file.
  const content = str(r.content);
  if (path && content !== undefined && str(r.to) === undefined) return diff(path, "", content);

  return undefined;
}
