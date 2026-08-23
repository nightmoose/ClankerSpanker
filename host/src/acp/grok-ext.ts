/**
 * Grok ACP extension wire formats for `x.ai/exit_plan_mode` and
 * `x.ai/ask_user_question`.
 *
 * These are xAI-specific internally-tagged enums on `outcome`. A nested
 * `{ outcome: { outcome: "accepted" } }` (the ACP permission shape) or
 * `{ type: "accepted" }` is not a valid reply — Grok fail-closes plan exit
 * to "keep planning" and rejects questions with
 * "missing field `outcome`", which fails the in-flight `session/prompt`.
 *
 * Recovered from grok-build-vscode research + grok CLI source
 * (`ExitPlanModeExtResponse`, `AskUserQuestionExtResponse`).
 */

export type ExitPlanVerdict = "approved" | "cancelled" | "abandoned";

/** JSON-RPC result body for `_x.ai/exit_plan_mode`. */
export function exitPlanResult(verdict: ExitPlanVerdict): { outcome: ExitPlanVerdict } {
  return { outcome: verdict };
}

/**
 * Map a phone approve/reject (or expiry/cancel) onto Grok's three native
 * plan-exit outcomes.
 *
 * - approve → `approved` (leave plan, implement in the same turn)
 * - reject  → `cancelled` (stay in plan, revise)
 * - expire / session cancel → `abandoned` (leave plan, end the planning turn)
 */
export function exitPlanVerdictFor(
  decision: "approve" | "reject" | "expire" | "cancel",
): ExitPlanVerdict {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "cancelled";
  return "abandoned";
}

export type QuestionOutcome =
  | { outcome: "accepted"; answers: Record<string, string>; annotations: Record<string, QuestionAnnotation> }
  | { outcome: "cancelled" }
  | { outcome: "skip_interview"; partial_answers: boolean }
  | { outcome: "chat_about_this"; content: string };

export interface QuestionAnnotation {
  notes?: string;
  preview?: string;
}

/** JSON-RPC result body for `_x.ai/ask_user_question` — user answered. */
export function questionAcceptedResult(
  answers: Record<string, string>,
  annotations: Record<string, QuestionAnnotation> = {},
): QuestionOutcome {
  return { outcome: "accepted", answers, annotations };
}

/** User dismissed / Skip / session cancelled. */
export function questionCancelledResult(): QuestionOutcome {
  return { outcome: "cancelled" };
}

/** Free-form "talk about this instead of picking an option". */
export function questionChatResult(content: string): QuestionOutcome {
  return { outcome: "chat_about_this", content };
}

/**
 * Zip parallel answer strings onto question text.
 * Grok wants `HashMap<question, chosenLabel>`; multi-select labels joined with `", "`.
 * The phone historically joined multi-select with `" | "` — normalize that.
 */
export function buildQuestionAnswers(
  questions: Array<{ question: string }>,
  answers: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const question = (questions[i]?.question ?? "").trim();
    if (!question) continue;
    const raw = (answers[i] ?? "").trim();
    if (!raw) continue;
    map[question] = raw.includes(" | ")
      ? raw
          .split(" | ")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ")
      : raw;
  }
  return map;
}

export function questionAnnotationsForComment(
  questions: Array<{ question: string }>,
  comment?: string,
): Record<string, QuestionAnnotation> {
  const notes = comment?.trim();
  const first = questions[0]?.question?.trim();
  if (!notes || !first) return {};
  return { [first]: { notes } };
}
