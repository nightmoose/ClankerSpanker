import type { DispatchSession, HostConfigFile, SessionEvent } from "../types.js";
import { isApnsConfigured, resolveApnsAuth, sendPush, type ApnsPayload } from "./apns.js";
import { dropPushTokens, loadPushDevices } from "./push-devices.js";

const ATTENTION_STATUSES = new Set(["awaiting_approval", "awaiting_question"]);

export function attentionBadgeCount(sessions: Array<Pick<DispatchSession, "status">>): number {
  let n = 0;
  for (const s of sessions) {
    if (ATTENTION_STATUSES.has(s.status)) n += 1;
  }
  return n;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function payloadFromEvent(
  event: SessionEvent,
  sessionTitle: string,
  badge: number,
  clientHostId: string,
): ApnsPayload | null {
  const raw = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
  const data: Record<string, string> = {
    hostId: clientHostId,
    sessionId: event.sessionId,
  };

  if (event.type === "approval.needed") {
    const approvalId = str(raw.id) ?? str(raw.approvalId);
    if (approvalId) data.approvalId = approvalId;
    data.kind = "approval";
    return {
      title: `Approval needed — ${sessionTitle}`,
      body: str(raw.title) ?? "Approval required",
      sound: "default",
      category: "APPROVAL_REQUEST",
      badge,
      data,
    };
  }
  if (event.type === "question.needed") {
    data.kind = "question";
    return {
      title: `Answers needed — ${sessionTitle}`,
      body: str(raw.title) ?? "Answers needed",
      sound: "default",
      category: "QUESTION_REQUEST",
      badge,
      data,
    };
  }
  if (event.type === "approval.resolved" || event.type === "question.answered") {
    return { badge, data: { ...data, kind: "badge" } };
  }
  return null;
}

export async function handleSessionPush(
  config: HostConfigFile,
  sessions: Array<Pick<DispatchSession, "id" | "status" | "title">>,
  event: SessionEvent,
): Promise<{ sent: number; skipped: string } | SendLike> {
  if (
    event.type !== "approval.needed" &&
    event.type !== "question.needed" &&
    event.type !== "approval.resolved" &&
    event.type !== "question.answered"
  ) {
    return { sent: 0, skipped: "event" };
  }
  const auth = resolveApnsAuth(config);
  if (!auth) return { sent: 0, skipped: "unconfigured" };
  const devices = loadPushDevices(config.dataDir);
  if (!devices.length) return { sent: 0, skipped: "no-devices" };

  let badge = attentionBadgeCount(sessions);
  if (event.type === "approval.needed" || event.type === "question.needed") {
    const already = sessions.some((s) => s.id === event.sessionId && ATTENTION_STATUSES.has(s.status));
    if (!already) badge += 1;
  }

  const sessionTitle =
    sessions.find((s) => s.id === event.sessionId)?.title?.trim() || "Session";

  let sent = 0;
  const invalid: string[] = [];
  for (const device of devices) {
    const payload = payloadFromEvent(event, sessionTitle, badge, device.clientHostId);
    if (!payload) continue;
    const result = await sendPush(auth, [device.token], payload);
    sent += result.sent;
    invalid.push(...result.invalid);
  }
  if (invalid.length) dropPushTokens(config.dataDir, invalid);
  return { sent, skipped: sent ? "" : "undelivered", invalid };
}

type SendLike = { sent: number; skipped: string; invalid?: string[] };

export async function sendTestPush(config: HostConfigFile): Promise<{
  configured: boolean;
  sent: number;
  deviceCount: number;
  error?: string;
}> {
  const auth = resolveApnsAuth(config);
  const devices = loadPushDevices(config.dataDir);
  if (!auth) return { configured: false, sent: 0, deviceCount: devices.length, error: "APNs not configured" };
  if (!devices.length) return { configured: true, sent: 0, deviceCount: 0, error: "No registered devices" };
  const result = await sendPush(
    auth,
    devices.map((d) => d.token),
    {
      title: "ClankerSpanker",
      body: "Push is working. Approvals will badge this icon when the app is closed.",
      sound: "default",
      badge: 1,
      data: { kind: "test" },
    },
  );
  if (result.invalid.length) dropPushTokens(config.dataDir, result.invalid);
  return { configured: true, sent: result.sent, deviceCount: devices.length };
}

export function pushStatus(config: HostConfigFile): {
  configured: boolean;
  deviceCount: number;
  bundleId: string | null;
} {
  const auth = resolveApnsAuth(config);
  return {
    configured: Boolean(auth) || isApnsConfigured(config),
    deviceCount: loadPushDevices(config.dataDir).length,
    bundleId: auth?.bundleId ?? config.apns?.bundleId ?? null,
  };
}
