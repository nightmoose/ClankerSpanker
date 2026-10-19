/**
 * Fail the static build if a published page would send the host token
 * (or any Authorization header) to a relative URL. On the public site a
 * relative URL is the static origin, not the operator's gateway.
 *
 * The gateway's own terminal page still posts to a relative /ws/ticket.
 * That file is not copied into the site. This guard is what keeps it out
 * of the publish, and what catches the same pattern in any other file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".md"]);
const CALL = /\b(?:fetch|sendBeacon)\s*\(/g;
const CREDENTIAL = /authorization|bearer|\btoken\b/i;

export function relativeCredentialSends(source) {
  const findings = [];
  CALL.lastIndex = 0;
  let match;
  while ((match = CALL.exec(source))) {
    const open = match.index + match[0].length - 1;
    const call = extractCall(source, open);
    const url = firstStringArg(call);
    if (!url || !isRelativeLiteral(url)) continue;
    if (!CREDENTIAL.test(call)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    findings.push({ line, url, excerpt: call.replace(/\s+/g, " ").slice(0, 160) });
  }
  return findings;
}

export function scanTree(root) {
  const findings = [];
  walk(root, (file) => {
    const ext = file.slice(file.lastIndexOf("."));
    if (!TEXT_EXT.has(ext)) return;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const hit of relativeCredentialSends(text)) {
      findings.push({ file: relative(root, file) || file, ...hit });
    }
  });
  return findings;
}

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, visit);
    else if (st.isFile()) visit(path);
  }
}

function extractCall(source, openParen) {
  let depth = 0;
  let quote = null;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

function firstStringArg(call) {
  const inner = call.slice(1);
  const m = inner.match(/^\s*(["'`])([\s\S]*?)\1/);
  return m ? m[2] : "";
}

/** A URL the browser would resolve against the page, not an absolute gateway. */
function isRelativeLiteral(url) {
  if (!url || url.includes("${")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../");
}
