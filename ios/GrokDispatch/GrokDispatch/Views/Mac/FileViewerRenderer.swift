#if os(macOS)
import Foundation

/// Builds the HTML string the file viewer's WKWebView renders. Handles:
///  - Markdown (via marked.js from jsdelivr CDN)
///  - HTML (raw, unchanged)
///  - Code files (syntax highlighting via highlight.js CDN)
///  - Plain text and unknown types (mono `<pre>`)
///  - Images (native `<img>`; requires baseURL be the file's directory)
enum FileViewerRenderer {
    static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "ico",
    ]

    static func isImage(ext: String) -> Bool {
        imageExtensions.contains(ext.lowercased())
    }

    /// Map a file extension to a highlight.js language identifier.
    /// Returns nil for extensions highlight.js can auto-detect (fine to omit).
    static func languageFor(ext: String) -> String? {
        switch ext.lowercased() {
        case "py", "pyi", "pyx": return "python"
        case "swift": return "swift"
        case "ts", "tsx": return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "json": return "json"
        case "yml", "yaml": return "yaml"
        case "toml": return "ini"
        case "sh", "bash", "zsh", "fish": return "bash"
        case "rs": return "rust"
        case "go": return "go"
        case "rb": return "ruby"
        case "java": return "java"
        case "kt", "kts": return "kotlin"
        case "c", "h": return "c"
        case "cpp", "cxx", "cc", "hpp", "hh": return "cpp"
        case "cs": return "csharp"
        case "sql": return "sql"
        case "css", "scss", "sass": return "css"
        case "xml", "plist", "pbxproj": return "xml"
        case "diff", "patch": return "diff"
        case "dockerfile": return "dockerfile"
        case "makefile", "mk": return "makefile"
        case "lua": return "lua"
        case "php": return "php"
        case "r": return "r"
        case "elm": return "elm"
        case "ex", "exs": return "elixir"
        case "hs": return "haskell"
        case "scala": return "scala"
        case "vim": return "vim"
        case "": return "plaintext"
        default: return nil
        }
    }

    // MARK: - Render entry points

    static func welcome() -> String {
        page(body: """
        <div class="empty">
          <div class="empty-icon">📄</div>
          <div class="empty-title">File viewer</div>
          <div class="empty-hint">Paste a path above, click the folder icon to browse, or open a file from a session's diff or tool call.</div>
        </div>
        """, extraHead: "")
    }

    static func error(_ message: String) -> String {
        let esc = escapeHTML(message)
        return page(body: "<div class=\"error\">Couldn't open file:<br><code>\(esc)</code></div>", extraHead: "")
    }

    static func render(text: String, filename: String, ext: String) -> String {
        let lower = ext.lowercased()
        if lower == "md" || lower == "markdown" {
            return renderMarkdown(text, filename: filename)
        }
        if lower == "html" || lower == "htm" {
            // Full-document HTML: hand off directly, respect the file's own <head>.
            return text
        }
        return renderCode(text, filename: filename, language: languageFor(ext: ext) ?? "plaintext")
    }

    static func renderImage(url: URL) -> String {
        let name = escapeHTML(url.lastPathComponent)
        // baseURL is set to url.deletingLastPathComponent() so a bare filename works.
        return page(
            body: """
            <div class="file-header">\(name)</div>
            <div class="image-wrap"><img src="\(name)" alt="\(name)"></div>
            """,
            extraHead: ""
        )
    }

    static func renderBinary(url: URL, size: Int) -> String {
        let name = escapeHTML(url.lastPathComponent)
        let kib = String(format: "%.1f", Double(size) / 1024.0)
        return page(
            body: """
            <div class="file-header">\(name)</div>
            <div class="binary-note">
              Binary or non-UTF8 file (\(kib) KiB). Preview not available.
            </div>
            """,
            extraHead: ""
        )
    }

    // MARK: - Renderers

    private static func renderCode(_ text: String, filename: String, language: String) -> String {
        let esc = escapeHTML(text)
        let name = escapeHTML(filename)
        let langAttr = escapeHTML(language)
        return page(
            body: """
            <div class="file-header">\(name) <span class="lang-tag">\(langAttr)</span></div>
            <pre><code class="language-\(langAttr)">\(esc)</code></pre>
            <script>
              if (window.hljs) { hljs.highlightAll(); }
            </script>
            """,
            extraHead: highlightAssets()
        )
    }

    private static func renderMarkdown(_ text: String, filename: String) -> String {
        // Base64-encode the source to avoid any escaping pitfalls in the JS
        // string context. atob() decodes it inside the WebView.
        let b64 = Data(text.utf8).base64EncodedString()
        let name = escapeHTML(filename)
        return page(
            body: """
            <div class="file-header">\(name) <span class="lang-tag">markdown</span></div>
            <div id="md-body" class="markdown-body"></div>
            <script>
              (function() {
                const b64 = "\(b64)";
                function b64decode(str) {
                  const bin = atob(str);
                  const bytes = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                  return new TextDecoder("utf-8").decode(bytes);
                }
                const source = b64decode(b64);
                function paint() {
                  if (!window.marked) { setTimeout(paint, 50); return; }
                  if (window.hljs) {
                    marked.setOptions({
                      highlight: function(code, lang) {
                        try {
                          if (lang && hljs.getLanguage(lang)) {
                            return hljs.highlight(code, { language: lang }).value;
                          }
                          return hljs.highlightAuto(code).value;
                        } catch (e) { return code; }
                      }
                    });
                  }
                  document.getElementById("md-body").innerHTML = marked.parse(source);
                }
                paint();
              })();
            </script>
            """,
            extraHead: markdownAssets()
        )
    }

    // MARK: - Assets (CDN — works with network; degrades to unstyled if offline)

    private static func highlightAssets() -> String {
        """
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">
        <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
        """
    }

    private static func markdownAssets() -> String {
        """
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">
        <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
        """
    }

    // MARK: - HTML shell

    private static func page(body: String, extraHead: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: dark; }
          html, body {
            margin: 0; padding: 0;
            background: transparent;
            color: #e8ecf1;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
            font-size: 13.5px;
            line-height: 1.55;
          }
          body { padding: 0 16px 40px; }
          .file-header {
            position: sticky; top: 0; z-index: 5;
            background: rgba(20, 22, 27, 0.92);
            backdrop-filter: blur(8px);
            padding: 10px 4px 8px;
            margin: 0 -16px 8px;
            padding-left: 16px; padding-right: 16px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 12px;
            color: #9ba7b4;
            display: flex; justify-content: space-between; align-items: center;
          }
          .lang-tag {
            font-size: 11px;
            padding: 2px 8px;
            background: rgba(255,255,255,0.06);
            border-radius: 10px;
            color: #8892a0;
          }
          pre {
            margin: 0;
            background: transparent;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 12.5px;
            line-height: 1.5;
            overflow-x: auto;
            white-space: pre;
          }
          code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
          .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
            margin: 1.2em 0 0.5em; line-height: 1.25; color: #f4f6f9;
          }
          .markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.3em; }
          .markdown-body h2 { font-size: 1.35em; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.25em; }
          .markdown-body h3 { font-size: 1.15em; }
          .markdown-body p { margin: 0.6em 0; }
          .markdown-body a { color: #6ea9ff; text-decoration: none; }
          .markdown-body a:hover { text-decoration: underline; }
          .markdown-body ul, .markdown-body ol { padding-left: 1.6em; }
          .markdown-body li { margin: 0.15em 0; }
          .markdown-body blockquote {
            border-left: 3px solid rgba(255,255,255,0.2);
            margin: 0.8em 0; padding: 0.2em 0.9em;
            color: #b7c1cd;
          }
          .markdown-body code {
            background: rgba(255,255,255,0.08);
            padding: 1.5px 5px; border-radius: 4px; font-size: 0.92em;
          }
          .markdown-body pre {
            background: rgba(0,0,0,0.35);
            padding: 12px 14px; border-radius: 8px;
            margin: 0.8em 0;
          }
          .markdown-body pre code { background: transparent; padding: 0; font-size: 12.5px; }
          .markdown-body table { border-collapse: collapse; margin: 0.6em 0; }
          .markdown-body th, .markdown-body td {
            border: 1px solid rgba(255,255,255,0.1);
            padding: 5px 10px;
          }
          .markdown-body th { background: rgba(255,255,255,0.05); }
          .markdown-body hr {
            border: none;
            border-top: 1px solid rgba(255,255,255,0.1);
            margin: 1.5em 0;
          }
          .image-wrap { text-align: center; padding: 20px 0; }
          .image-wrap img { max-width: 100%; height: auto; border-radius: 6px; }
          .binary-note {
            padding: 30px; text-align: center;
            color: #8892a0; font-size: 12px;
          }
          .empty {
            text-align: center; padding: 60px 20px; color: #8892a0;
          }
          .empty-icon { font-size: 44px; margin-bottom: 12px; opacity: 0.7; }
          .empty-title { font-size: 15px; font-weight: 600; color: #b7c1cd; margin-bottom: 6px; }
          .empty-hint { font-size: 12.5px; max-width: 320px; margin: 0 auto; }
          .error {
            padding: 20px; margin-top: 20px;
            background: rgba(255, 90, 90, 0.1);
            border: 1px solid rgba(255, 90, 90, 0.3);
            border-radius: 6px;
            color: #ff9d9d;
            font-family: ui-monospace, monospace; font-size: 12px;
          }
          .error code { display: block; margin-top: 6px; word-break: break-all; opacity: 0.85; }
          /* highlight.js github-dark background — WebView keeps our transparent bg */
          .hljs { background: transparent !important; }
        </style>
        \(extraHead)
        </head>
        <body>
        \(body)
        </body>
        </html>
        """
    }

    private static func escapeHTML(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }
}
#endif
