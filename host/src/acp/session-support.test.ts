import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_IMAGES,
  normalizeAcpMethod,
  normalizeImages,
  normalizeQuestions,
  rawIsExitPlan,
} from "./session-support.js";

// RFC-051: direct tests for helpers moved out of session-manager.ts.

describe("normalizeAcpMethod", () => {
  it("maps underscore-prefixed xAI extension methods", () => {
    expect(normalizeAcpMethod("_x.ai/ask_user")).toBe("x.ai/ask_user");
    expect(normalizeAcpMethod("session/update")).toBe("session/update");
  });
});

describe("normalizeQuestions", () => {
  it("accepts string and object options, drops empty questions", () => {
    const q = normalizeQuestions([
      { question: "Which DB?", options: ["Postgres", { label: "SQLite", description: "file" }, {}], multi_select: true },
      { question: "  " },
      "nope",
    ]);
    expect(q).toEqual([
      {
        question: "Which DB?",
        options: [{ label: "Postgres" }, { label: "SQLite", description: "file", preview: undefined }],
        multiSelect: true,
      },
    ]);
    expect(normalizeQuestions(null)).toEqual([]);
  });
});

describe("normalizeImages", () => {
  const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  it("keeps valid images, strips data-URL prefixes, fixes image/jpg", () => {
    const out = normalizeImages([
      { mimeType: "image/jpg", data: "data:image/jpeg;base64,/9j/4AAQ" },
      { mimeType: "text/plain", data: "aGk=" },
      { mimeType: "image/png", data: "" },
    ]);
    expect(out).toEqual([{ mimeType: "image/jpeg", data: "/9j/4AAQ", name: undefined }]);
  });

  it("caps the number of images", () => {
    expect(normalizeImages(Array.from({ length: 10 }, () => png))).toHaveLength(MAX_PROMPT_IMAGES);
  });
});

describe("rawIsExitPlan", () => {
  it("recognises the ExitPlanMode variant only", () => {
    expect(rawIsExitPlan({ variant: "ExitPlanMode" })).toBe(true);
    expect(rawIsExitPlan({ variant: "Bash" })).toBe(false);
    expect(rawIsExitPlan(null)).toBe(false);
  });
});
