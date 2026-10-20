import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_PATH, refusesRealConfigUnderTest } from "./config.js";

describe("tests never write the real gateway config", () => {
  it("points GROK_DISPATCH_CONFIG away from the real config", () => {
    expect(process.env.GROK_DISPATCH_CONFIG).toBeTruthy();
    expect(process.env.GROK_DISPATCH_CONFIG).not.toBe(DEFAULT_CONFIG_PATH);
  });

  it("refuses the default path under vitest, and only there", () => {
    expect(refusesRealConfigUnderTest(DEFAULT_CONFIG_PATH, { VITEST: "true" })).toBe(true);
    expect(refusesRealConfigUnderTest(DEFAULT_CONFIG_PATH, {})).toBe(false);
    expect(refusesRealConfigUnderTest("/tmp/elsewhere/config.json", { VITEST: "true" })).toBe(false);
  });
});
