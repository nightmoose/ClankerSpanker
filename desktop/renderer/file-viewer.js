"use strict";

/**
 * Local-only file preview HTML. No CDN scripts — Electron CSP is script-src 'self'.
 */
const FileViewer = (() => {
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic"]);

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function page(body) {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  html, body { margin: 0; padding: 0; background: #0b0b10; color: #e8e8ee; font: 14px/1.5 system-ui, sans-serif; }
  .wrap { padding: 16px 18px 24px; }
  .empty, .error { text-align: center; padding: 48px 16px; color: #a1a1aa; }
  .empty-title { color: #f2f2f7; font-weight: 650; margin-top: 8px; }
  .error { color: #ff6b6b; }
  h1, h2, h3 { font-weight: 650; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: #12121a; border: 1px solid #2a2a36; border-radius: 10px; padding: 12px; overflow: auto; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  img.preview { max-width: 100%; height: auto; border-radius: 8px; }
  .md p { margin: 0.6em 0; }
  .md h1, .md h2, .md h3 { margin: 1em 0 0.4em; }
  .md ul { padding-left: 1.3em; }
  .fname { font-size: 11px; color: #a1a1aa; margin-bottom: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
  }

  function welcome() {
    return page(`<div class="empty">
      <div style="font-size:36px">📄</div>
      <div class="empty-title">File viewer</div>
      <div>Paste a path, browse, or open a file from a session's tool call or diff.</div>
      <div style="margin-top:8px;font-size:12px">Local disk only — same constraint as the Mac pane.</div>
    </div>`);
  }

  function error(message) {
    return page(`<div class="error">Couldn't open file:<br><code>${esc(message)}</code></div>`);
  }

  function lightMarkdown(text) {
    const escaped = esc(text);
    const blocks = escaped.split(/```(?:[a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g);
    let html = "";
    for (let i = 0; i < blocks.length; i++) {
      if (i % 2 === 1) {
        html += `<pre>${blocks[i]}</pre>`;
        continue;
      }
      const chunk = blocks[i]
        .replace(/^### (.+)$/gm, "<h3>$1</h3>")
        .replace(/^## (.+)$/gm, "<h2>$1</h2>")
        .replace(/^# (.+)$/gm, "<h1>$1</h1>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
        .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
        .replace(/\n\n+/g, "</p><p>")
        .replace(/\n/g, "<br/>");
      html += `<div class="md"><p>${chunk}</p></div>`;
    }
    return html;
  }

  function render({ path, filename, ext, text, dataUrl, binary, error: err }) {
    if (err) return error(err);
    const name = filename || path || "file";
    const lower = String(ext || "").toLowerCase();
    const head = `<div class="fname">${esc(name)}</div>`;
    if (dataUrl && IMAGE_EXT.has(lower)) {
      return page(`${head}<img class="preview" src="${esc(dataUrl)}" alt="${esc(name)}" />`);
    }
    if (binary) {
      return page(`${head}<div class="empty">Binary file — use Reveal in folder.</div>`);
    }
    if (text == null) return error("Empty file");
    if (lower === "md" || lower === "markdown") {
      return page(`${head}${lightMarkdown(text)}`);
    }
    return page(`${head}<pre>${esc(text)}</pre>`);
  }

  function isImage(ext) {
    return IMAGE_EXT.has(String(ext || "").toLowerCase());
  }

  return { welcome, error, render, isImage };
})();
