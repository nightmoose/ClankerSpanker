import type { Bot, DispatchSession, HostConfigFile } from "../types.js";
import type { BotStore } from "./store.js";
import { parseIntervalMs } from "./store.js";

const TICK_MS = 30_000;

export interface BotFireTarget {
  fireBot(bot: Bot): Promise<DispatchSession>;
  hasActiveRun(botId: string): boolean;
}

/**
 * In-process interval walker. Skips a bot when its previous session is still
 * running or awaiting_approval. `unref`s so it doesn't keep the process alive
 * on its own (same pattern as the approval sweeper).
 */
export class BotScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly store: BotStore,
    private readonly target: BotFireTarget,
    private readonly config: HostConfigFile,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref?.();
    // Don't fire immediately — first run waits for the interval, plus a manual /run.
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Exposed for tests. */
  async tick(nowMs = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      for (const bot of this.store.list()) {
        if (!bot.enabled) continue;
        const interval = parseIntervalMs(bot.interval);
        if (!interval) continue;
        if (this.target.hasActiveRun(bot.id)) continue;
        const last = bot.lastRunAt ? Date.parse(bot.lastRunAt) : 0;
        if (Number.isFinite(last) && last > 0 && nowMs - last < interval) continue;
        try {
          const session = await this.target.fireBot(bot);
          this.store.update(bot.id, {
            lastRunAt: new Date(nowMs).toISOString(),
            lastSessionId: session.id,
          });
          fired.push(bot.id);
        } catch (err) {
          console.warn(
            `[bot-scheduler] fire failed bot=${bot.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Whether this bot already has a live run (used by REST /run too). */
  static isActiveStatus(status: string): boolean {
    return status === "queued" || status === "running" || status === "awaiting_approval";
  }
}

export { TICK_MS };
