/**
 * Build the static product site.
 *
 * Copies the browser control plane from host/web into both / and /app/
 * so the script is not forked. Authored pages under site/docs and
 * site/download are copied beside it. Output is site/dist and is not
 * committed.
 */
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(siteDir, "..");
const webRoot = join(repoRoot, "host", "web");
const out = join(siteDir, "dist");

const index = join(webRoot, "index.html");
try {
  if (!statSync(index).isFile()) throw new Error("not a file");
} catch {
  console.error(`site build: missing ${index}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(webRoot, out, { recursive: true });
cpSync(webRoot, join(out, "app"), { recursive: true });
cpSync(join(siteDir, "docs"), join(out, "docs"), { recursive: true });
cpSync(join(siteDir, "download"), join(out, "download"), { recursive: true });
cpSync(join(siteDir, "site.css"), join(out, "site.css"));

console.log(`site build: wrote ${out}`);
