/**
 * Build the static product site.
 *
 * Copies the browser control plane from host/web into both / and /app/
 * so the script is not forked. The host terminal page is left out: it
 * posts the bearer token to a relative /ws/ticket, which is correct only
 * when the page itself is served by the gateway. Authored pages under
 * site/docs and site/download are copied beside the control plane.
 * Output is site/dist and is not committed.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "./static-origin-guard.mjs";

const siteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(siteDir, "..");
const webRoot = join(repoRoot, "host", "web");

function skipTerminal(src) {
  return !src.endsWith(`${sep}terminal.html`);
}

export function buildSite(out) {
  const index = join(webRoot, "index.html");
  try {
    if (!statSync(index).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`site build: missing ${index}`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  cpSync(webRoot, out, { recursive: true, filter: skipTerminal });
  cpSync(webRoot, join(out, "app"), { recursive: true, filter: skipTerminal });
  cpSync(join(siteDir, "docs"), join(out, "docs"), { recursive: true });
  cpSync(join(siteDir, "download"), join(out, "download"), { recursive: true });
  cpSync(join(siteDir, "site.css"), join(out, "site.css"));

  for (const rel of ["terminal.html", join("app", "terminal.html")]) {
    if (existsSync(join(out, rel))) {
      throw new Error(`site build: ${rel} must not be published (it posts the host token to a relative URL)`);
    }
  }

  const leaks = scanTree(out);
  if (leaks.length) {
    const lines = leaks.map((hit) => `${hit.file}:${hit.line} ${hit.url} ${hit.excerpt}`);
    throw new Error(
      "site build: a published file sends Authorization or a token to a relative URL\n" + lines.join("\n"),
    );
  }
  return out;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const out = join(siteDir, "dist");
  buildSite(out);
  console.log(`site build: wrote ${out}`);
}
