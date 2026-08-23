import { describe, it, expect } from "vitest";
import {
  buildQuestionAnswers,
  exitPlanResult,
  exitPlanVerdictFor,
  questionAcceptedResult,
  questionAnnotationsForComment,
  questionCancelledResult,
  questionChatResult,
} from "./grok-ext.js";

describe("exitPlanResult", () => {
  it("sends a flat outcome, not the nested permission shape", () => {
    // The old host replied { outcome: { outcome: "accepted" } }. Grok's
    // ExitPlanModeExtResponse is internally tagged on `outcome` with
    // approved | cancelled | abandoned, and fail-closes unknown values to
    // cancelled — which is "stay in plan mode".
    expect(exitPlanResult("approved")).toEqual({ outcome: "approved" });
    expect(exitPlanResult("cancelled")).toEqual({ outcome: "cancelled" });
    expect(exitPlanResult("abandoned")).toEqual({ outcome: "abandoned" });
    expect(JSON.stringify(exitPlanResult("approved"))).not.toContain("accepted");
    expect(JSON.stringify(exitPlanResult("approved"))).not.toMatch(/"outcome":\{/);
  });
});

describe("exitPlanVerdictFor", () => {
  it("maps phone decisions onto native verdicts", () => {
    expect(exitPlanVerdictFor("approve")).toBe("approved");
    expect(exitPlanVerdictFor("reject")).toBe("cancelled");
    expect(exitPlanVerdictFor("expire")).toBe("abandoned");
    expect(exitPlanVerdictFor("cancel")).toBe("abandoned");
  });
});

describe("questionAcceptedResult", () => {
  it("tags on outcome (not type) and keys answers by question text", () => {
    // The old host replied { type: "accepted", answers: ["A"] }. Grok then
    // reports "missing field `outcome`" and the in-flight session/prompt fails.
    const answers = { "Which file?": "src/main.ts" };
    const body = questionAcceptedResult(answers);
    expect(body).toEqual({
      outcome: "accepted",
      answers,
      annotations: {},
    });
    expect("type" in body).toBe(false);
    expect(Array.isArray((body as { answers: unknown }).answers)).toBe(false);
  });
});

describe("questionCancelledResult / questionChatResult", () => {
  it("uses the internally-tagged outcome names", () => {
    expect(questionCancelledResult()).toEqual({ outcome: "cancelled" });
    expect(questionChatResult("let's talk")).toEqual({
      outcome: "chat_about_this",
      content: "let's talk",
    });
  });
});

describe("buildQuestionAnswers", () => {
  it("zips parallel answer strings onto question text", () => {
    expect(
      buildQuestionAnswers(
        [{ question: "Target?" }, { question: "Scope?" }],
        ["host/", "ACP only"],
      ),
    ).toEqual({ "Target?": "host/", "Scope?": "ACP only" });
  });

  it("normalizes the phone's multi-select join to Grok's comma join", () => {
    expect(
      buildQuestionAnswers([{ question: "Pick files" }], ["a.ts | b.ts | c.ts"]),
    ).toEqual({ "Pick files": "a.ts, b.ts, c.ts" });
  });

  it("skips blank answers and blank questions", () => {
    expect(
      buildQuestionAnswers([{ question: "" }, { question: "Q" }], ["nope", "  "]),
    ).toEqual({});
  });
});

describe("questionAnnotationsForComment", () => {
  it("attaches optional notes to the first question", () => {
    expect(questionAnnotationsForComment([{ question: "Q1" }, { question: "Q2" }], "  be careful  ")).toEqual({
      Q1: { notes: "be careful" },
    });
  });

  it("returns empty when there is no comment or no question", () => {
    expect(questionAnnotationsForComment([{ question: "Q" }], "  ")).toEqual({});
    expect(questionAnnotationsForComment([], "hi")).toEqual({});
  });
});
