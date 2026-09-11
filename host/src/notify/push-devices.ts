import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_RE = /^[0-9a-fA-F]{32,200}$/;
const MAX_DEVICES = 20;

export interface PushDevice {
  token: string;
  clientHostId: string;
  name?: string;
  bundleId: string;
  updatedAt: string;
}

export function pushDevicesPath(dataDir: string): string {
  return join(dataDir, "push-devices.json");
}

export function loadPushDevices(dataDir: string): PushDevice[] {
  const p = pushDevicesPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { devices?: PushDevice[] } | PushDevice[];
    const list = Array.isArray(raw) ? raw : (raw.devices ?? []);
    return list.filter((d) => d && typeof d.token === "string" && TOKEN_RE.test(d.token));
  } catch {
    return [];
  }
}

export function savePushDevices(dataDir: string, devices: PushDevice[]): void {
  const p = pushDevicesPath(dataDir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify({ devices }, null, 2) + "\n", { mode: 0o600 });
}

export function normalizeToken(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toLowerCase();
}

export function registerPushDevice(
  dataDir: string,
  input: { token: string; clientHostId: string; name?: string; bundleId?: string },
): PushDevice {
  const token = normalizeToken(input.token);
  if (!TOKEN_RE.test(token)) throw new Error("Invalid APNs device token");
  const clientHostId = String(input.clientHostId ?? "").trim();
  if (!clientHostId) throw new Error("clientHostId is required");
  const now = new Date().toISOString();
  const next: PushDevice = {
    token,
    clientHostId,
    name: input.name?.trim() || undefined,
    bundleId: input.bundleId?.trim() || "com.nightmoose.clankerspanker",
    updatedAt: now,
  };
  const rest = loadPushDevices(dataDir).filter((d) => d.token !== token);
  rest.unshift(next);
  savePushDevices(dataDir, rest.slice(0, MAX_DEVICES));
  return next;
}

export function unregisterPushDevice(dataDir: string, token: string): boolean {
  const want = normalizeToken(token);
  const list = loadPushDevices(dataDir);
  const next = list.filter((d) => d.token !== want);
  if (next.length === list.length) return false;
  savePushDevices(dataDir, next);
  return true;
}

export function dropPushTokens(dataDir: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const drop = new Set(tokens.map(normalizeToken));
  const list = loadPushDevices(dataDir);
  const next = list.filter((d) => !drop.has(d.token));
  const removed = list.length - next.length;
  if (removed) savePushDevices(dataDir, next);
  return removed;
}
