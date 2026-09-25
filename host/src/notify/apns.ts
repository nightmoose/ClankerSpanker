import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import http2 from "node:http2";
import type { ApnsConfig, HostConfigFile } from "../types.js";

/** APNs is HTTP/2-only. Auth is an ES256 JWT from the .p8 key. */

export interface ApnsAuth {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8: string;
  environment: "sandbox" | "production" | "auto";
}

export interface ApnsPayload {
  title?: string;
  body?: string;
  badge: number;
  sound?: string;
  category?: string;
  data?: Record<string, string>;
}

export interface SendPushResult {
  invalid: string[];
  sent: number;
  failures: Array<{ reason: string; env: "production" | "sandbox" }>;
}

export function normalizeApnsKey(raw: string): string {
  let key = raw.trim().replace(/^['"]|['"]$/g, "");
  key = key.replace(/\\n/g, "\n").replace(/\r/g, "");
  const body = key
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

/** JWT ES256 wants r||s (64 bytes), not DER. Node sometimes still emits DER. */
export function derToJoseP256(der: Buffer): Buffer {
  if (der.length === 64) return der;
  if (der[0] !== 0x30) throw new Error(`Unexpected ECDSA signature format (len=${der.length})`);
  let offset = 2;
  if ((der[1] & 0x80) !== 0) offset += der[1] & 0x7f;
  const takeInt = (): Buffer => {
    if (der[offset++] !== 0x02) throw new Error("Invalid DER INTEGER");
    const len = der[offset++];
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > 32) throw new Error("ECDSA integer too large for P-256");
    const out = Buffer.alloc(32);
    bytes.copy(out, 32 - bytes.length);
    return out;
  };
  return Buffer.concat([takeInt(), takeInt()]);
}

function envTrim(name: string): string | undefined {
  const v = process.env[name]?.trim().replace(/^['"]|['"]$/g, "");
  return v || undefined;
}

function readKeyFile(dataDir: string, keyPath: string): string | undefined {
  const resolved = isAbsolute(keyPath) ? keyPath : join(dataDir, keyPath);
  if (!existsSync(resolved)) return undefined;
  return readFileSync(resolved, "utf8");
}

export function resolveApnsAuth(config: HostConfigFile): ApnsAuth | null {
  const block: ApnsConfig = config.apns ?? {};
  const keyId = envTrim("APNS_KEY_ID") ?? block.keyId?.trim();
  const teamId = envTrim("APNS_TEAM_ID") ?? block.teamId?.trim();
  const bundleId =
    envTrim("APNS_BUNDLE_ID") ?? block.bundleId?.trim() ?? "com.nightmoose.clankerspanker";
  const envRaw = (envTrim("APNS_ENV") ?? block.environment ?? "auto").toLowerCase();
  const environment: ApnsAuth["environment"] =
    envRaw === "sandbox" || envRaw === "production" ? envRaw : "auto";

  const rawP8 =
    envTrim("APNS_KEY_P8") ??
    (envTrim("APNS_KEY_PATH")
      ? readKeyFile(config.dataDir, envTrim("APNS_KEY_PATH")!)
      : undefined) ??
    block.keyP8 ??
    (block.keyPath ? readKeyFile(config.dataDir, block.keyPath) : undefined);

  if (!keyId || !teamId || !rawP8) return null;
  if (!/^[A-Z0-9]{10}$/i.test(keyId) || !/^[A-Z0-9]{10}$/i.test(teamId)) return null;
  try {
    const p8 = normalizeApnsKey(rawP8);
    createPrivateKey(p8);
    return { keyId, teamId, bundleId, p8, environment };
  } catch {
    return null;
  }
}

export function isApnsConfigured(config: HostConfigFile): boolean {
  return resolveApnsAuth(config) !== null;
}

export function apnsJwt(auth: ApnsAuth): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: auth.keyId })).toString(
    "base64url",
  );
  // Apple rejects tokens whose iat is in the future (clock skew).
  const iat = Math.floor(Date.now() / 1000) - 10;
  const claims = Buffer.from(JSON.stringify({ iss: auth.teamId, iat })).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const key = createPrivateKey(auth.p8);
  const rawSig = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  const sig = rawSig.length === 64 ? Buffer.from(rawSig) : derToJoseP256(Buffer.from(rawSig));
  return `${unsigned}.${sig.toString("base64url")}`;
}

function hostFor(env: "production" | "sandbox"): string {
  return env === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
}

function connectApns(env: "production" | "sandbox"): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${hostFor(env)}`);
    const timer = setTimeout(() => {
      session.destroy();
      reject(new Error(`APNs ${env} connect timeout`));
    }, 5000);
    session.once("connect", () => {
      clearTimeout(timer);
      resolve(session);
    });
    session.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function requestOnSession(
  session: http2.ClientHttp2Session,
  token: string,
  bundleId: string,
  jwt: string,
  body: string,
  pushType: "alert" | "background",
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const req = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": pushType,
      "apns-priority": pushType === "alert" ? "10" : "5",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
      "content-type": "application/json",
    });
    let status = 0;
    let data = "";
    const timer = setTimeout(() => {
      req.close();
      resolve({ ok: false, reason: "timeout" });
    }, 6000);
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (status >= 200 && status < 300) {
        resolve({ ok: true });
        return;
      }
      let reason = status ? `http_${status}` : "no_status";
      try {
        const json = JSON.parse(data) as { reason?: string };
        if (json.reason) reason = json.reason;
      } catch {
        if (data) reason = data.slice(0, 120);
      }
      resolve({ ok: false, reason });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message || "http2_error" });
    });
    req.end(body);
  });
}

/** APNs rejects alert payloads over 4096 bytes (`PayloadTooLarge`). Leave headroom. */
export const APNS_MAX_BYTES = 4000;
const TITLE_MAX_CHARS = 120;
const BODY_MAX_CHARS = 400;

/** Cut to `max` code points (never splits a surrogate pair) with an ellipsis. */
export function clampText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/**
 * RFC-031: approval titles can carry a whole shell command or diff, which
 * blew past 4 KB and APNs dropped the notification. Clamp title/body, then
 * shrink the body until the encoded JSON fits.
 */
export function encodeApnsBody(payload: ApnsPayload): string {
  const aps: Record<string, unknown> = {
    badge: Math.max(0, payload.badge),
  };
  const rest = payload.data ?? {};
  if (!(payload.title || payload.body)) {
    return JSON.stringify({ aps, ...rest });
  }
  const title = clampText(payload.title ?? "ClankerSpanker", TITLE_MAX_CHARS);
  let body = clampText(payload.body ?? "", BODY_MAX_CHARS);
  if (payload.sound) aps.sound = payload.sound;
  if (payload.category) aps.category = payload.category;
  const encode = () => JSON.stringify({ aps: { ...aps, alert: { title, body } }, ...rest });
  let json = encode();
  while (Buffer.byteLength(json, "utf8") > APNS_MAX_BYTES && body.length > 0) {
    const chars = Array.from(body);
    body = clampText(body, Math.floor(chars.length * 0.75));
    if (Array.from(body).length >= chars.length) body = "";
    json = encode();
  }
  return json;
}

async function sendOnEnvironment(
  env: "production" | "sandbox",
  tokens: string[],
  auth: ApnsAuth,
  jwt: string,
  payload: ApnsPayload,
): Promise<Map<string, { ok: boolean; reason?: string }>> {
  const out = new Map<string, { ok: boolean; reason?: string }>();
  if (!tokens.length) return out;
  const body = encodeApnsBody(payload);
  const pushType: "alert" | "background" = payload.title || payload.body ? "alert" : "alert";

  let session: http2.ClientHttp2Session;
  try {
    session = await connectApns(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const token of tokens) out.set(token, { ok: false, reason });
    return out;
  }

  session.on("error", (err) => {
    console.warn("[push] http2 session error:", env, err.message);
  });
  try {
    for (const token of tokens) {
      out.set(token, await requestOnSession(session, token, auth.bundleId, jwt, body, pushType));
    }
  } finally {
    session.close();
  }
  return out;
}

function preferredEnv(auth: ApnsAuth): "production" | "sandbox" {
  return auth.environment === "production" ? "production" : "sandbox";
}

export async function sendPush(auth: ApnsAuth, tokens: string[], payload: ApnsPayload): Promise<SendPushResult> {
  const unique = [...new Set(tokens.filter(Boolean))];
  const preferred = preferredEnv(auth);
  if (!unique.length) return { invalid: [], sent: 0, failures: [] };

  const jwt = apnsJwt(auth);
  const first = await sendOnEnvironment(preferred, unique, auth, jwt, payload);

  const sent = new Set<string>();
  const invalid: string[] = [];
  const failures: SendPushResult["failures"] = [];
  const retry: string[] = [];

  for (const token of unique) {
    const result = first.get(token) ?? { ok: false, reason: "no_result" };
    if (result.ok) {
      sent.add(token);
      continue;
    }
    const reason = result.reason ?? "unknown";
    if (
      reason === "BadDeviceToken" ||
      /timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|closed|reset/i.test(reason)
    ) {
      retry.push(token);
      failures.push({ reason, env: preferred });
    } else if (reason === "Unregistered" || reason === "ExpiredProviderToken") {
      invalid.push(token);
      failures.push({ reason, env: preferred });
    } else {
      failures.push({ reason, env: preferred });
      console.warn("[push] delivery failed:", token.slice(0, 8), preferred, reason);
    }
  }

  const other: "production" | "sandbox" = preferred === "production" ? "sandbox" : "production";
  if (retry.length && auth.environment === "auto") {
    console.warn(`[push] retrying ${retry.length} token(s) on ${other}`);
    const second = await sendOnEnvironment(other, retry, auth, jwt, payload);
    for (const token of retry) {
      const result = second.get(token) ?? { ok: false, reason: "no_result" };
      if (result.ok) {
        sent.add(token);
        continue;
      }
      const reason = result.reason ?? "unknown";
      failures.push({ reason, env: other });
      if (reason === "BadDeviceToken" || reason === "Unregistered") invalid.push(token);
      else console.warn("[push] retry delivery failed:", token.slice(0, 8), other, reason);
    }
  } else if (retry.length) {
    for (const token of retry) {
      const result = first.get(token);
      if (result?.reason === "BadDeviceToken" || result?.reason === "Unregistered") {
        invalid.push(token);
      }
    }
  }

  console.info(
    `[push] sent=${sent.size}/${unique.length} invalid=${invalid.length} failures=${failures.length}`,
  );
  return { invalid: [...new Set(invalid)], sent: sent.size, failures };
}
