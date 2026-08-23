import { describe, expect, it } from "vitest";
import { encodeAgyCredsBlob, parseAgyCredsBlob } from "./gemini-cli-auth.js";

describe("parseAgyCredsBlob", () => {
  it("reads nested token JSON", () => {
    const parsed = parseAgyCredsBlob(
      JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "ya29.abc",
          refresh_token: "1//xyz",
          token_type: "Bearer",
          expiry: "2026-08-21T00:00:00.000Z",
        },
      }),
    );
    expect(parsed?.accessToken).toBe("ya29.abc");
    expect(parsed?.refreshToken).toBe("1//xyz");
    expect(parsed?.expiryMs).toBe(Date.parse("2026-08-21T00:00:00.000Z"));
  });

  it("reads go-keyring-base64 blobs", () => {
    const inner = JSON.stringify({
      token: { access_token: "tok", refresh_token: "ref" },
      auth_method: "consumer",
    });
    const blob = "go-keyring-base64:" + Buffer.from(inner, "utf8").toString("base64");
    const parsed = parseAgyCredsBlob(blob);
    expect(parsed?.accessToken).toBe("tok");
    expect(parsed?.refreshToken).toBe("ref");
  });

  it("round-trips through encodeAgyCredsBlob", () => {
    const parsed = parseAgyCredsBlob(
      JSON.stringify({ token: { access_token: "a", refresh_token: "b" }, auth_method: "consumer" }),
    )!;
    const again = parseAgyCredsBlob(encodeAgyCredsBlob(parsed));
    expect(again?.accessToken).toBe("a");
    expect(again?.refreshToken).toBe("b");
  });
});
