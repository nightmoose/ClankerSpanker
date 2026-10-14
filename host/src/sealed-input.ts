import { randomUUID } from "node:crypto";
import type { PendingSecretRequest } from "./types.js";

/**
 * RFC-058 — Sealed secret input manager.
 *
 * Parallel to `PendingApproval` / `PendingQuestion`: host code calls
 * `request()` when it needs a value from the user that must not touch
 * the agent (today: project database connection strings). The returned
 * promise settles when the client POSTs `/sessions/:id/secret` with
 * either `{ value }` or `{ cancel: true }`.
 *
 * `onEvent` is injected so the manager stays decoupled from the session
 * event bus — the caller wires it to `session.emitEvent` with the right
 * payload. The value is **never** passed to `onEvent`; only slot
 * metadata is.
 */

export interface SealedInputRequestInput {
  sessionId: string;
  projectId: string;
  slot: string;
  purpose: string;
  hint?: string;
  /** Milliseconds before the request auto-cancels; 0 = never. */
  ttlMs?: number;
}

export interface SealedInputResult {
  /** True when the user submitted a value, false when they cancelled or it expired. */
  ok: boolean;
  /** Mirror of the slot name; present on success so callers can confirm what filled. */
  slot?: string;
}

type Pending = {
  request: PendingSecretRequest;
  resolve: (result: SealedInputResult) => void;
  timer?: NodeJS.Timeout;
};

/** Public shape surfaced to the client (never includes the value). */
export type PublicSecretRequest = Omit<PendingSecretRequest, never>;

export class SealedInputManager {
  private readonly pending = new Map<string, Pending>();
  private readonly onEvent?: (
    kind: "secret.needed" | "secret.resolved",
    payload: Record<string, unknown>,
  ) => void;
  private readonly writeSecret: (
    projectId: string,
    slot: string,
    value: string,
  ) => void;

  constructor(opts: {
    writeSecret: (projectId: string, slot: string, value: string) => void;
    onEvent?: (
      kind: "secret.needed" | "secret.resolved",
      payload: Record<string, unknown>,
    ) => void;
  }) {
    this.writeSecret = opts.writeSecret;
    this.onEvent = opts.onEvent;
  }

  /** Open a request; the returned promise resolves on submit/cancel/expire. */
  request(input: SealedInputRequestInput): {
    id: string;
    public: PublicSecretRequest;
    done: Promise<SealedInputResult>;
  } {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = input.ttlMs && input.ttlMs > 0
      ? new Date(Date.now() + input.ttlMs).toISOString()
      : undefined;
    const req: PendingSecretRequest = {
      id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      slot: input.slot,
      purpose: input.purpose,
      hint: input.hint,
      createdAt,
      expiresAt,
    };
    let resolveFn!: (r: SealedInputResult) => void;
    const done = new Promise<SealedInputResult>((resolve) => {
      resolveFn = resolve;
    });
    const entry: Pending = { request: req, resolve: resolveFn };
    if (input.ttlMs && input.ttlMs > 0) {
      entry.timer = setTimeout(() => this.cancel(id, "expired"), input.ttlMs);
    }
    this.pending.set(id, entry);
    this.onEvent?.("secret.needed", { request: req });
    return { id, public: req, done };
  }

  /** User submitted a value. Writes to the secret store, resolves the promise. */
  submit(id: string, value: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.clearTimer(entry);
    this.pending.delete(id);
    this.writeSecret(entry.request.projectId, entry.request.slot, value);
    entry.resolve({ ok: true, slot: entry.request.slot });
    this.onEvent?.("secret.resolved", {
      requestId: id,
      slot: entry.request.slot,
      outcome: "submitted",
    });
    return true;
  }

  /** User tapped Cancel in the modal (or expiry fired). */
  cancel(id: string, outcome: "cancelled" | "expired" = "cancelled"): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.clearTimer(entry);
    this.pending.delete(id);
    entry.resolve({ ok: false });
    this.onEvent?.("secret.resolved", {
      requestId: id,
      slot: entry.request.slot,
      outcome,
    });
    return true;
  }

  /** All requests belonging to `sessionId` get cancelled (session close/cancel). */
  cancelForSession(sessionId: string): number {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) {
        this.cancel(id, "cancelled");
        n += 1;
      }
    }
    return n;
  }

  get(id: string): PendingSecretRequest | undefined {
    return this.pending.get(id)?.request;
  }

  listForSession(sessionId: string): PendingSecretRequest[] {
    return [...this.pending.values()]
      .filter((e) => e.request.sessionId === sessionId)
      .map((e) => e.request);
  }

  private clearTimer(entry: Pending) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }
}
