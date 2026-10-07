import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HostConfigFile, ProjectInfo } from "../types.js";
import { isUsableCwd, normalizeProject, saveConfig } from "../config.js";
import { expandHome } from "../project-resolve.js";
import type { BotStore } from "./store.js";

export const HUNTER_BOT_ID = "contractgate-hunter";
/** Display/owner chip — hunter runs show under NightMoose, not a separate profile. */
export const OWNER_PROFILE_ID = "nightmoose";
/** Legacy chip we used to seed; hidden and no longer required. */
export const BOT_PROFILE_ID = "nightmoose-bot";

const HUNTER_JOB = `You are ContractGate Hunter, an autonomous researcher for ContractGate — a lightweight enforcement gate for data contracts (especially Kafka / Schema Registry / streaming pipelines).

Each run:
1. Search (web_search) then open pages (web_fetch). Pain to look for: poison events, producer-consumer disagreement, schema evolution breakage, "a schema is not a contract", shift-left data quality in streaming, Schema Registry as a false sense of safety.
2. If search is thin, still web_fetch known public writing — Confluent Schema Registry posts, Conduktor "a schema is not a contract", Adam Bellemare on streaming data products/contracts, Chad Sanderson on data contracts, Kai Wähner on Kafka + data quality. Do not stop at the search snippet.
3. Write a dated brief (today's UTC date) under .bot-outbox/ naming people, what they wrote, and why they might care. Empty search ≠ empty market.
4. For the strongest 1–3 leads, call propose_outbound with a short, peer-to-peer draft in the maintainer's voice. Reference one specific thing they wrote. No hype. Private 1:1. Offer a 15-minute screen-share or a private look at the gate. Single clear ask.
5. Do not mention competitors as dumpster fires. Do not claim we emailed or posted anything. You cannot send.

Never use shell. File writes stay in .bot-outbox/. Do not conclude there is no market because a search tool returned nothing.`;

export interface SeedHunterOptions {
  /** Checkout to bind. Defaults to ~/contractgate. */
  contractgateDir?: string;
  /** Where project adds are written. Tests pass a scratch file. */
  configPath?: string;
}

/**
 * Idempotent: bind the hunter to the project that actually covers
 * ~/contractgate, or create that project when the checkout is on this
 * machine and nothing covers it. A host with no checkout and no such
 * project does not keep a hunter pinned to a missing id — Run now on
 * that copy is a 400 (`Unknown projectId`). Disabled, owned by
 * NightMoose. Does not add an extra profile chip.
 */
export function seedHunter(
  config: HostConfigFile,
  store: BotStore,
  opts?: SeedHunterOptions,
): void {
  const dir = opts?.contractgateDir ?? join(homedir(), "contractgate");
  hideLegacyBotChip(config, opts?.configPath);
  const projectId = ensureContractgateProject(config, dir, opts?.configPath);
  const ownerId = ownerProfileId(config);
  if (projectId) ensureHunterBot(store, ownerId, projectId);
  else dropUnboundHunter(store);
  ensureOutboxGitignore(dir);
}

function ownerProfileId(config: HostConfigFile): string {
  if (config.profiles.some((p) => p.id === OWNER_PROFILE_ID)) return OWNER_PROFILE_ID;
  const grok = config.profiles.find((p) => p.backend === "grok" && p.id !== BOT_PROFILE_ID);
  if (grok) return grok.id;
  return config.profiles[0]?.id ?? OWNER_PROFILE_ID;
}

/** Drop the leftover "NightMoose Bot" chip — hunter sessions belong on NightMoose. */
function hideLegacyBotChip(config: HostConfigFile, configPath?: string): void {
  const next = config.profiles.filter((p) => p.id !== BOT_PROFILE_ID && p.backend !== "bot");
  if (next.length === config.profiles.length) return;
  config.profiles = next;
  saveConfig(config, configPath);
}

function projectDirs(project: Pick<ProjectInfo, "path" | "paths">): string[] {
  const listed = (project.paths ?? []).map((p) => p.trim()).filter(Boolean);
  const all = listed.length > 0 ? listed : (project.path?.trim() ? [project.path] : []);
  return all.map((p) => resolve(expandHome(p)));
}

function coversDir(project: Pick<ProjectInfo, "path" | "paths">, dir: string): boolean {
  const wanted = resolve(dir);
  return projectDirs(project).some((p) => p === wanted);
}

/**
 * Id of the project Run now can dispatch into, or null when this host
 * has neither a usable `contractgate` project nor the checkout on disk.
 */
function ensureContractgateProject(
  config: HostConfigFile,
  dir: string,
  configPath?: string,
): string | null {
  const usable = existsSync(dir) && isUsableCwd(dir);
  const byPath = config.projects.find((p) => coversDir(p, dir));
  if (byPath && usable) return byPath.id;

  const byId = config.projects.find((p) => p.id === "contractgate");
  if (byId) {
    if (projectDirs(byId).some((p) => isUsableCwd(p))) return byId.id;
    if (usable) {
      const idx = config.projects.findIndex((p) => p.id === "contractgate");
      config.projects[idx] = normalizeProject({ ...byId, name: byId.name || "ContractGate", path: dir, paths: [dir] });
      saveConfig(config, configPath);
      return byId.id;
    }
    return null;
  }

  if (!usable) return null;
  config.projects.push(
    normalizeProject({
      id: "contractgate",
      name: "ContractGate",
      path: dir,
      color: "#73B8FF",
    }),
  );
  saveConfig(config, configPath);
  return "contractgate";
}

function ensureHunterBot(store: BotStore, profileId: string, projectId: string): void {
  const existing = store.get(HUNTER_BOT_ID);
  if (existing) {
    const patch: { profileId?: string; job?: string; projectId?: string } = {};
    if (existing.profileId === BOT_PROFILE_ID || existing.profileId !== profileId) {
      patch.profileId = profileId;
    }
    if (existing.projectId !== projectId) patch.projectId = projectId;
    if (!existing.job.includes("Do not conclude there is no market")) {
      patch.job = HUNTER_JOB;
    }
    if (Object.keys(patch).length) store.update(HUNTER_BOT_ID, patch);
    return;
  }
  store.create({
    id: HUNTER_BOT_ID,
    name: "ContractGate Hunter",
    enabled: false,
    profileId,
    projectId,
    job: HUNTER_JOB,
    interval: "6h",
    tools: [],
    maxTurnsPerRun: 20,
  });
}

/** Seeded hunter whose project id is not on this host. Leaves any other bot alone. */
function dropUnboundHunter(store: BotStore): void {
  const existing = store.get(HUNTER_BOT_ID);
  if (!existing || existing.projectId !== "contractgate") return;
  store.delete(HUNTER_BOT_ID);
}

function ensureOutboxGitignore(repo: string): void {
  if (!existsSync(repo)) return;
  const outbox = join(repo, ".bot-outbox");
  mkdirSync(outbox, { recursive: true });
  const ignore = join(outbox, ".gitignore");
  if (!existsSync(ignore)) {
    writeFileSync(ignore, "*\n!.gitignore\n", "utf8");
  }
  const gi = join(repo, ".gitignore");
  if (!existsSync(gi)) return;
  const text = readFileSync(gi, "utf8");
  if (text.split(/\r?\n/).some((l) => l.trim() === ".bot-outbox/" || l.trim() === ".bot-outbox")) {
    return;
  }
  const suffix = text.endsWith("\n") ? "" : "\n";
  writeFileSync(gi, `${text}${suffix}\n# ClankerSpanker hunter outbox (drafts, never sent)\n.bot-outbox/\n`, "utf8");
}
