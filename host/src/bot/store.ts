import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "../types.js";

interface BotsFile {
  bots: Bot[];
}

export class BotStore {
  private file: string;
  private bots: Bot[] = [];

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "bots.json");
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.file)) {
      this.bots = [];
      this.persist();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BotsFile>;
      this.bots = Array.isArray(raw.bots) ? raw.bots.map(normalizeBot).filter((b): b is Bot => b !== null) : [];
    } catch {
      this.bots = [];
    }
  }

  list(): Bot[] {
    return this.bots.map((b) => ({ ...b }));
  }

  get(id: string): Bot | null {
    const hit = this.bots.find((b) => b.id === id);
    return hit ? { ...hit } : null;
  }

  create(input: Partial<Bot> & { name: string; profileId: string; projectId: string; job: string }): Bot {
    const bot = normalizeBot({
      id: input.id?.trim() || randomUUID(),
      name: input.name,
      enabled: input.enabled ?? false,
      profileId: input.profileId,
      projectId: input.projectId,
      job: input.job,
      interval: input.interval ?? "6h",
      tools: input.tools ?? [],
      maxTurnsPerRun: input.maxTurnsPerRun,
      lastRunAt: input.lastRunAt,
      lastSessionId: input.lastSessionId,
    });
    if (!bot) throw new Error("Invalid bot");
    if (this.bots.some((b) => b.id === bot.id)) throw new Error(`Bot id already exists: ${bot.id}`);
    this.bots.push(bot);
    this.persist();
    return { ...bot };
  }

  update(id: string, patch: Partial<Bot>): Bot {
    const idx = this.bots.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error("Bot not found");
    const merged = normalizeBot({ ...this.bots[idx]!, ...patch, id });
    if (!merged) throw new Error("Invalid bot patch");
    this.bots[idx] = merged;
    this.persist();
    return { ...merged };
  }

  upsert(bot: Bot): Bot {
    const existing = this.bots.findIndex((b) => b.id === bot.id);
    const next = normalizeBot(bot);
    if (!next) throw new Error("Invalid bot");
    if (existing >= 0) this.bots[existing] = next;
    else this.bots.push(next);
    this.persist();
    return { ...next };
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify({ bots: this.bots }, null, 2) + "\n", "utf8");
  }
}

export function normalizeBot(raw: Partial<Bot> | null | undefined): Bot | null {
  if (!raw?.name?.trim() || !raw.profileId?.trim() || !raw.projectId?.trim() || !raw.job?.trim()) {
    return null;
  }
  const interval = (raw.interval ?? "6h").trim() || "6h";
  if (!parseIntervalMs(interval)) return null;
  const maxTurns = Number(raw.maxTurnsPerRun);
  return {
    id: (raw.id?.trim() || randomUUID()),
    name: raw.name.trim(),
    enabled: Boolean(raw.enabled),
    profileId: raw.profileId.trim(),
    projectId: raw.projectId.trim(),
    job: raw.job,
    interval,
    tools: Array.isArray(raw.tools) ? raw.tools.map((s) => String(s).trim()).filter(Boolean) : [],
    maxTurnsPerRun: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 20,
    lastRunAt: raw.lastRunAt,
    lastSessionId: raw.lastSessionId,
  };
}

/** Parse "30s" / "15m" / "1h" / "6h" / "1d". Returns 0 if invalid. */
export function parseIntervalMs(raw: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(raw.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2]!.toLowerCase();
  const mul = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mul;
}
