import type { HostConfigFile } from "../types.js";
import type { SessionManager } from "../acp/session-manager.js";
import { BotScheduler } from "./scheduler.js";
import { BotStore } from "./store.js";
import { seedHunter } from "./seed.js";

export interface BotRuntime {
  store: BotStore;
  scheduler: BotScheduler;
  stop(): void;
}

export function startBotRuntime(config: HostConfigFile, manager: SessionManager): BotRuntime {
  const store = new BotStore(config.dataDir);
  try {
    seedHunter(config, store);
  } catch (err) {
    console.warn("[bot] seed failed:", err instanceof Error ? err.message : err);
  }
  const scheduler = new BotScheduler(store, manager, config);
  scheduler.start();
  console.log(`[bot] ${store.list().length} bot(s) loaded from ${config.dataDir}/bots.json`);
  return {
    store,
    scheduler,
    stop() {
      scheduler.stop();
    },
  };
}

export { BotStore } from "./store.js";
export { BotScheduler } from "./scheduler.js";
export { parseIntervalMs } from "./store.js";
export { pickProvider, selectProviderKind } from "./providers/index.js";
export { runBotLoop } from "./loop.js";
export { runBotSession } from "./runner.js";
export { HUNTER_BOT_ID, BOT_PROFILE_ID, OWNER_PROFILE_ID, seedHunter } from "./seed.js";
