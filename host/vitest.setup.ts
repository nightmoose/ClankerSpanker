import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test worker gets its own config path, so a test that triggers
// saveConfig without setting GROK_DISPATCH_CONFIG writes a temp file, never
// the operator's ~/.grok-dispatch/config.json.
if (!process.env.GROK_DISPATCH_CONFIG) {
  process.env.GROK_DISPATCH_CONFIG = join(mkdtempSync(join(tmpdir(), "cs-test-config-")), "config.json");
}
