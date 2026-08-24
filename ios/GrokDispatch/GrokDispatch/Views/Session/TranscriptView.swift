import SwiftUI

struct TranscriptView: View {
    let entries: [TranscriptEntry]
    var toolCalls: [ToolCallRecord] = []
    var streaming: String = ""
    /// Subtle "still working…" pulse when true and no streaming text.
    var isRunning: Bool = false
    /// Display name for assistant bubbles (Claude / Grok / Antigravity).
    var agentLabel: String = "Agent"
    /// When true, hide tool rows, thoughts, and system lines — chat messages only.
    var chatOnly: Bool = false

    /// Long-press context-menu hooks. Set any or all to expose those actions
    /// on the bubble's long-press menu. Parent presents the corresponding
    /// sheet.
    var onSaveAsTodo: ((TranscriptEntry) -> Void)? = nil
    var onScanForTodo: ((TranscriptEntry) -> Void)? = nil
    var onMakeNote: ((TranscriptEntry) -> Void)? = nil
    /// When set (e.g. arriving from a todo), expand that transcript entry.
    var expandMessageId: String? = nil

    @State private var expanded: ExpandedMessage?

    /// Merged oldest-first stream: transcript entries + tool calls sorted by
    /// timestamp ascending. Standard chat convention — reader scrolls down as
    /// new turns arrive. Fills the long gaps between assistant text with a
    /// live parade of "read foo.ts / bash npm test / edit bar.ts" instead of
    /// a blank screen.
    private enum Item: Identifiable {
        case entry(TranscriptEntry)
        case tool(ToolCallRecord)

        var id: String {
            switch self {
            case .entry(let e): return "entry-\(e.id)"
            case .tool(let t): return "tool-\(t.toolCallId)"
            }
        }
        var timestamp: String {
            switch self {
            case .entry(let e): return e.at
            case .tool(let t): return t.updatedAt
            }
        }
    }

    private var ordered: [Item] {
        let chatRoles: Set<String> = ["user", "assistant"]
        let visibleEntries = chatOnly
            ? entries.filter { chatRoles.contains($0.role) }
            : entries
        var items: [Item] = visibleEntries.map { .entry($0) }
        if !chatOnly {
            items.append(contentsOf: toolCalls.map { .tool($0) })
        }
        return items.sorted { $0.timestamp < $1.timestamp }
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(ordered) { item in
                switch item {
                case .entry(let entry):
                    bubble(id: entry.id, role: entry.role, text: entry.text, isStreaming: false)
                        .id(entry.id)
                        .transition(.opacity)
                        .contextMenu {
                            if let onSaveAsTodo {
                                Button {
                                    onSaveAsTodo(entry)
                                } label: {
                                    Label("Save as todo", systemImage: "checkmark.circle")
                                }
                            }
                            if let onScanForTodo {
                                Button {
                                    onScanForTodo(entry)
                                } label: {
                                    Label("Scan for todo", systemImage: "sparkle.magnifyingglass")
                                }
                            }
                            if let onMakeNote {
                                Button {
                                    onMakeNote(entry)
                                } label: {
                                    Label("Make note", systemImage: "note.text.badge.plus")
                                }
                            }
                        }
                case .tool(let tool):
                    toolRow(tool)
                        .id("tool-\(tool.toolCallId)")
                        .transition(.opacity)
                }
            }

            // Streaming assistant text / "still working" indicator lives at
            // the bottom so it flows in naturally as the next-newest content.
            if !streaming.isEmpty {
                bubble(
                    id: "streaming",
                    role: "assistant",
                    text: streaming,
                    isStreaming: true
                )
                .id("streaming")
                .transition(.opacity)
            } else if isRunning {
                stillWorkingRow
                    .id("still-working")
                    .transition(.opacity)
            }

            // Sentinel scroll target for auto-scroll-to-bottom on new content.
            // Tall enough that LazyVStack is more likely to keep it addressable
            // once the reader has scrolled near the end.
            Color.clear
                .frame(height: 8)
                .id(SessionDetailView.transcriptBottomAnchor)
        }
        .animation(.easeInOut(duration: 0.18), value: streaming)
        .animation(.easeInOut(duration: 0.18), value: entries.count)
        .animation(.easeInOut(duration: 0.18), value: toolCalls.count)
        .animation(.easeInOut(duration: 0.18), value: isRunning)
        // fullScreenCover is iOS-only; Mac uses a large sheet instead.
        #if os(iOS)
        .fullScreenCover(item: $expanded) { item in
            ExpandedMessageView(item: item) {
                expanded = nil
            }
        }
        #else
        .sheet(item: $expanded) { item in
            ExpandedMessageView(item: item) {
                expanded = nil
            }
            .frame(minWidth: 520, minHeight: 420)
        }
        #endif
        .onAppear { tryExpand(expandMessageId) }
        .onChange(of: expandMessageId) { _, id in tryExpand(id) }
        .onChange(of: entries.count) { _, _ in tryExpand(expandMessageId) }
    }

    private func tryExpand(_ id: String?) {
        guard expanded == nil, let id, !id.isEmpty else { return }
        guard let entry = entries.first(where: { $0.id == id }) else { return }
        expanded = ExpandedMessage(
            id: entry.id,
            role: entry.role,
            text: entry.text,
            title: roleLabel(entry.role)
        )
    }

    // MARK: - Message bubble

    private func bubble(id: String, role: String, text: String, isStreaming: Bool) -> some View {
        HStack {
            if role == "user" { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(roleLabel(role))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    if text.count > 160 || text.contains("\n") {
                        Button {
                            expanded = ExpandedMessage(
                                id: id,
                                role: role,
                                text: text,
                                title: roleLabel(role)
                            )
                        } label: {
                            Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right")
                                .labelStyle(.iconOnly)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(DispatchColors.accent)
                                .frame(width: 28, height: 28)
                                .background(DispatchColors.accent.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Expand message full screen")
                    }
                }
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
                    .lineLimit(isStreaming ? nil : 12)
            }
            .padding(12)
            .background(background(for: role))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if role != "user" { Spacer(minLength: 24) }
        }
        // Tag with the entry id so ScrollViewReader can scroll to it when
        // the user taps "Jump to message" in Notes/Tasks.
        .id(id)
    }

    // MARK: - Inline tool activity row

    @ViewBuilder
    private func toolRow(_ tool: ToolCallRecord) -> some View {
        HStack(spacing: 8) {
            Image(systemName: toolIcon(for: tool))
                .font(.caption)
                .foregroundStyle(toolColor(for: tool.status))
                .frame(width: 16)
            Text(tool.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
            if let subtitle = toolSubtitle(for: tool) {
                Text(subtitle)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Text(toolStatusLabel(tool.status))
                .font(.caption2.weight(.medium))
                .foregroundStyle(toolColor(for: tool.status))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func toolIcon(for tool: ToolCallRecord) -> String {
        let title = tool.title.lowercased()
        if title.contains("read") { return "doc.text" }
        if title.contains("write") { return "square.and.pencil" }
        if title.contains("edit") { return "pencil" }
        if title.contains("bash") || title.contains("run") { return "terminal" }
        if title.contains("grep") || title.contains("search") { return "magnifyingglass" }
        if title.contains("glob") || title.contains("list") { return "folder" }
        if title.contains("todo") { return "checklist" }
        if title.contains("fetch") || title.contains("web") { return "globe" }
        switch tool.kind?.lowercased() {
        case "edit": return "pencil"
        case "execute": return "terminal"
        case "search": return "magnifyingglass"
        case "read": return "doc.text"
        default: return "wrench.and.screwdriver"
        }
    }

    private func toolSubtitle(for tool: ToolCallRecord) -> String? {
        tool.locations?.first?.path
    }

    private func toolColor(for status: String) -> Color {
        switch status.lowercased() {
        case "completed": return DispatchColors.accent
        case "failed", "error": return DispatchColors.danger
        case "pending", "running", "in_progress": return DispatchColors.warning
        default: return .secondary
        }
    }

    private func toolStatusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "completed": return "done"
        case "pending", "running", "in_progress": return "…"
        case "failed", "error": return "failed"
        default: return status.lowercased()
        }
    }

    // MARK: - Still-working pulse

    private var stillWorkingRow: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .scaleEffect(0.8)
            Text("Still working…")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DispatchColors.accent.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "user": return "You"
        case "assistant": return agentLabel
        case "thought": return "Thinking"
        case "system": return "System"
        default: return role.capitalized
        }
    }

    private func background(for role: String) -> Color {
        switch role {
        case "user": return DispatchColors.accent.opacity(0.2)
        case "system": return DispatchColors.warning.opacity(0.15)
        case "thought": return Color.white.opacity(0.04)
        default: return Color.white.opacity(0.08)
        }
    }
}

// MARK: - Full-screen pop-out

struct ExpandedMessage: Identifiable, Hashable {
    let id: String
    let role: String
    let text: String
    let title: String
}

struct ExpandedMessageView: View {
    let item: ExpandedMessage
    var onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                DispatchBackground()
                ScrollView {
                    MarkdownView(text: item.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            }
            .navigationTitle(item.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { onDismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: item.text) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: - Markdown rendering

/// Lightweight block-level markdown renderer used by the expanded-message
/// popup. Handles headings, unordered/ordered lists, fenced code blocks,
/// blockquotes, horizontal rules, and paragraphs with inline emphasis /
/// links / inline code via `AttributedString(markdown:)`. Falls back to
/// plain text on any parse error so a broken snippet never blanks the view.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownParser.blocks(from: text).enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
    }

    @ViewBuilder
    private func render(_ block: MarkdownParser.Block) -> some View {
        switch block {
        case .heading(let level, let content):
            Text(inline(content))
                .font(headingFont(level))
                .textSelection(.enabled)
        case .paragraph(let content):
            Text(inline(content))
                .font(.body)
                .textSelection(.enabled)
        case .code(let body):
            Text(body)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        case .quote(let content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.white.opacity(0.25))
                    .frame(width: 3)
                Text(inline(content))
                    .font(.body.italic())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        case .unorderedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inline(item))
                            .textSelection(.enabled)
                    }
                }
            }
        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(idx + 1).").foregroundStyle(.secondary)
                        Text(inline(item))
                            .textSelection(.enabled)
                    }
                }
            }
        case .rule:
            Divider().background(Color.white.opacity(0.2))
        case .table(let headers, let rows):
            markdownTable(headers: headers, rows: rows)
        }
    }

    @ViewBuilder
    private func markdownTable(headers: [String], rows: [[String]]) -> some View {
        let cols = max(headers.count, rows.map(\.count).max() ?? 0)
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(0..<cols, id: \.self) { i in
                        Text(inline(i < headers.count ? headers[i] : ""))
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
                .background(Color.white.opacity(0.08))
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().gridCellColumns(cols)
                    GridRow {
                        ForEach(0..<cols, id: \.self) { i in
                            Text(inline(i < row.count ? row[i] : ""))
                                .font(.caption)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
            )
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title.weight(.bold)
        case 2: return .title2.weight(.semibold)
        default: return .title3.weight(.semibold)
        }
    }

    private func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        if let attr = try? AttributedString(markdown: s, options: opts) {
            return attr
        }
        return AttributedString(s)
    }
}

enum MarkdownParser {
    enum Block {
        case heading(level: Int, content: String)
        case paragraph(String)
        case code(String)
        case quote(String)
        case unorderedList([String])
        case orderedList([String])
        case rule
        case table(headers: [String], rows: [[String]])
    }

    static func blocks(from text: String) -> [Block] {
        var blocks: [Block] = []
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll()
        }

        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flushParagraph()
                i += 1
                var code: [String] = []
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 } // skip closing fence
                blocks.append(.code(code.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            if let (level, content) = headingParts(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: level, content: content))
                i += 1
                continue
            }

            if i + 1 < lines.count,
               looksLikeTableRow(trimmed),
               isTableSeparator(lines[i + 1].trimmingCharacters(in: .whitespaces)) {
                flushParagraph()
                let headers = splitPipeCells(trimmed)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.isEmpty { break }
                    if !looksLikeTableRow(t) { break }
                    if isTableSeparator(t) { i += 1; continue }
                    rows.append(splitPipeCells(t))
                    i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if let content = bulletContent(trimmed) {
                flushParagraph()
                var items: [String] = [content]
                i += 1
                while i < lines.count,
                      let next = bulletContent(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(next)
                    i += 1
                }
                blocks.append(.unorderedList(items))
                continue
            }

            if let content = orderedContent(trimmed) {
                flushParagraph()
                var items: [String] = [content]
                i += 1
                while i < lines.count,
                      let next = orderedContent(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(next)
                    i += 1
                }
                blocks.append(.orderedList(items))
                continue
            }

            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                var quoteLines: [String] = [String(trimmed.dropFirst(trimmed.hasPrefix("> ") ? 2 : 1))]
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("> ") {
                        quoteLines.append(String(t.dropFirst(2)))
                        i += 1
                    } else if t == ">" {
                        quoteLines.append("")
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            paragraph.append(raw)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    private static func headingParts(_ line: String) -> (Int, String)? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        for ch in line {
            if ch == "#" { level += 1 } else { break }
            if level > 6 { return nil }
        }
        guard level >= 1, line.count > level, line[line.index(line.startIndex, offsetBy: level)] == " " else {
            return nil
        }
        let content = String(line.dropFirst(level + 1))
        return (level, content)
    }

    private static func bulletContent(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ "] {
            if line.hasPrefix(marker) { return String(line.dropFirst(marker.count)) }
        }
        return nil
    }

    private static func orderedContent(_ line: String) -> String? {
        // Match `<digits>. ` prefix.
        var idx = line.startIndex
        while idx < line.endIndex, line[idx].isNumber { idx = line.index(after: idx) }
        guard idx > line.startIndex else { return nil }
        guard idx < line.endIndex, line[idx] == "." else { return nil }
        let after = line.index(after: idx)
        guard after < line.endIndex, line[after] == " " else { return nil }
        return String(line[line.index(after: after)...])
    }

    /// GFM pipe table: at least two `|` and not a fence.
    static func looksLikeTableRow(_ line: String) -> Bool {
        guard line.contains("|") else { return false }
        return line.filter { $0 == "|" }.count >= 1 && !line.hasPrefix("```")
    }

    /// `| --- | :---: | ---: |` (min three dashes per cell). Must contain `|`
    /// so a lone `---` stays a horizontal rule, not a one-column table.
    static func isTableSeparator(_ line: String) -> Bool {
        guard line.contains("|") else { return false }
        let cells = splitPipeCells(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let t = cell.replacingOccurrences(of: " ", with: "")
            return t.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil
        }
    }

    static func splitPipeCells(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
