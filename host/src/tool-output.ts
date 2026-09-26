/**
 * Compact command output for tool rows (RFC-040). Tool rows only said "done",
 * so a failed command (e.g. `pytest` missing) was invisible until the agent
 * retried. Keep the tail — that's where errors are.
 */
export const OUTPUT_PREVIEW_LINES = 6;
export const OUTPUT_PREVIEW_CHARS = 600;

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as { type?: string; text?: unknown; content?: { type?: string; text?: unknown } };
    if (block.type === "content" && typeof block.content?.text === "string") parts.push(block.content.text);
    else if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

export function toolOutputSummary(
  content: unknown,
  rawOutput: unknown,
): { outputPreview?: string; exitCode?: number } {
  const raw = rawOutput && typeof rawOutput === "object" ? (rawOutput as Record<string, unknown>) : {};
  let text = textFromContent(content);
  if (!text.trim()) {
    const fromRaw = raw.output_for_prompt ?? raw.output ?? raw.stdout;
    if (typeof fromRaw === "string") text = fromRaw;
    else if (Array.isArray(fromRaw)) text = fromRaw.filter((x) => typeof x === "string").join("\n");
  }
  const out: { outputPreview?: string; exitCode?: number } = {};
  const exit = raw.exit_code ?? raw.exitCode;
  if (typeof exit === "number") out.exitCode = exit;
  const tail = outputTail(text);
  if (tail) out.outputPreview = tail;
  return out;
}

/** Last few lines of tool output, capped (RFC-040; Claude path RFC-056). */
export function outputTail(text: string): string | undefined {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return undefined;
  const tail = trimmed.split("\n").slice(-OUTPUT_PREVIEW_LINES).join("\n");
  return tail.length > OUTPUT_PREVIEW_CHARS ? "…" + tail.slice(-OUTPUT_PREVIEW_CHARS) : tail;
}
