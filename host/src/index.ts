import { loadConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { SessionManager } from "./acp/session-manager.js";
import { startBotRuntime } from "./bot/index.js";
import { startServer } from "./server.js";

async function main() {
  const config = loadConfig();
  console.log(`[boot] Config: ${DEFAULT_CONFIG_PATH}`);
  console.log(`[boot] Grok binary: ${config.grokBinary}`);
  console.log(`[boot] Projects: ${config.projects.map((p) => p.name).join(", ") || "(none)"}`);
  console.log(
    `[boot] Profiles: ${config.profiles.map((p) => `${p.name}/${p.backend}`).join(", ") || "(none)"}`,
  );
  console.log(`[boot] Data dir: ${config.dataDir}`);
  console.log(`[boot] Auto-approve kinds: ${config.autoApproveKinds.join(", ")}`);
  console.log(`[boot] Host token (first 8): ${config.hostToken.slice(0, 8)}…`);

  const manager = new SessionManager(config);
  const bots = startBotRuntime(config, manager);
  const { shutdown } = startServer(config, manager, bots);

  const onSignal = async (sig: string) => {
    console.log(`\n[boot] ${sig} — shutting down…`);
    bots.stop();
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
}

main().catch((err) => {
  console.error("[boot] Fatal:", err);
  process.exit(1);
});
