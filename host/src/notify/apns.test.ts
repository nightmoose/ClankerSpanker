import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostConfigFile } from "../types.js";
import {
  APNS_MAX_BYTES,
  apnsJwt,
  clampText,
  derToJoseP256,
  encodeApnsBody,
  normalizeApnsKey,
  resolveApnsAuth,
} from "./apns.js";

describe("normalizeApnsKey", () => {
  it("turns escaped newlines into a PEM", () => {
    const raw = "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n";
    const out = normalizeApnsKey(raw);
    expect(out).toContain("-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----");
    expect(out).not.toContain("\\n");
  });

  it("wraps a bare key", () => {
    const out = normalizeApnsKey("ABCDEF");
    expect(out.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(out).toContain("\nABCDEF\n");
    expect(out.trim().endsWith("-----END PRIVATE KEY-----")).toBe(true);
  });

  it("strips wrapping quotes", () => {
    const out = normalizeApnsKey('"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"');
    expect(out.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(out).toContain("\nABC\n");
  });
});

describe("derToJoseP256", () => {
  it("passes through a 64-byte JOSE signature", () => {
    const jose = Buffer.alloc(64, 7);
    expect(derToJoseP256(jose).equals(jose)).toBe(true);
  });

  it("converts a DER signature of r=1,s=1", () => {
    const der = Buffer.from("3006020101020101", "hex");
    const jose = derToJoseP256(der);
    expect(jose.length).toBe(64);
    expect(jose.subarray(0, 31).every((b) => b === 0)).toBe(true);
    expect(jose[31]).toBe(1);
    expect(jose.subarray(32, 63).every((b) => b === 0)).toBe(true);
    expect(jose[63]).toBe(1);
  });
});

describe("resolveApnsAuth + jwt", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  function cfg(over: Partial<HostConfigFile> = {}): HostConfigFile {
    return {
      hostToken: "t",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      grokBinary: "grok",
      projects: [],
      allowCustomPaths: true,
      profiles: [],
      autoApproveKinds: [],
      notifyDesktop: false,
      dataDir: mkdtempSync(join(tmpdir(), "cs-apns-")),
      ...over,
    };
  }

  it("returns null when APNs is missing", () => {
    expect(resolveApnsAuth(cfg())).toBeNull();
  });

  it("loads a key from keyPath under dataDir", () => {
    const config = cfg();
    writeFileSync(join(config.dataDir, "AuthKey.p8"), pem, { mode: 0o600 });
    const auth = resolveApnsAuth({
      ...config,
      apns: {
        keyId: "ABCD123456",
        teamId: "XHS7K665C9",
        keyPath: "AuthKey.p8",
        bundleId: "com.nightmoose.clankerspanker",
      },
    });
    expect(auth).not.toBeNull();
    expect(auth!.bundleId).toBe("com.nightmoose.clankerspanker");
    const jwt = apnsJwt(auth!);
    const [h, c, s] = jwt.split(".");
    expect(h && c && s).toBeTruthy();
    const header = JSON.parse(Buffer.from(h!, "base64url").toString("utf8")) as { kid: string; alg: string };
    expect(header).toMatchObject({ alg: "ES256", kid: "ABCD123456" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString("utf8")) as { iss: string };
    expect(claims.iss).toBe("XHS7K665C9");
  });

  it("rejects a short key id", () => {
    const config = cfg({
      apns: { keyId: "short", teamId: "XHS7K665C9", keyP8: pem },
    });
    expect(resolveApnsAuth(config)).toBeNull();
  });
});

describe("encodeApnsBody", () => {
  it("puts alert + category + custom data on an approval", () => {
    const body = JSON.parse(
      encodeApnsBody({
        title: "Approval needed — Foo",
        body: "Edit src",
        sound: "default",
        category: "APPROVAL_REQUEST",
        badge: 2,
        data: { kind: "approval", sessionId: "s1", hostId: "h1" },
      }),
    ) as Record<string, unknown>;
    expect(body.aps).toMatchObject({
      badge: 2,
      sound: "default",
      category: "APPROVAL_REQUEST",
      alert: { title: "Approval needed — Foo", body: "Edit src" },
    });
    expect(body).toMatchObject({ kind: "approval", sessionId: "s1", hostId: "h1" });
  });

  it("omits alert on a badge-only payload", () => {
    const body = JSON.parse(encodeApnsBody({ badge: 0 })) as { aps: Record<string, unknown> };
    expect(body.aps).toEqual({ badge: 0 });
    expect(body.aps.alert).toBeUndefined();
  });
});

describe("encodeApnsBody payload size (RFC-031)", () => {
  const base = { badge: 1, sound: "default", category: "APPROVAL_REQUEST", data: { hostId: "h", sessionId: "s", kind: "approval" } };

  it("keeps a huge approval title under the APNs limit", () => {
    const huge = "rm -rf /tmp/x && " + "echo a very long shell command ".repeat(500);
    const json = encodeApnsBody({ ...base, title: `Approval needed — ${huge}`, body: huge });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(APNS_MAX_BYTES);
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe("s");
    expect(parsed.aps.alert.title.endsWith("…")).toBe(true);
  });

  it("fits multi-byte text too", () => {
    const emoji = "🦀".repeat(3000);
    const json = encodeApnsBody({ ...base, title: emoji, body: emoji });
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(APNS_MAX_BYTES);
  });

  it("leaves short payloads untouched", () => {
    const parsed = JSON.parse(encodeApnsBody({ ...base, title: "Approval needed — Fix", body: "Edit calc.py" }));
    expect(parsed.aps.alert).toEqual({ title: "Approval needed — Fix", body: "Edit calc.py" });
  });
});

describe("clampText", () => {
  it("never splits a surrogate pair", () => {
    expect(clampText("🦀🦀🦀", 2)).toBe("🦀…");
    expect(clampText("abc", 5)).toBe("abc");
  });
});
