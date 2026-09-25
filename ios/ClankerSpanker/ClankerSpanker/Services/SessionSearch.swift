import Foundation

/// Shared session text search (local fields + host `?q=` merge).
enum SessionSearch {
    /// Tokenize a query: lowercase alphanumerics, drop empties.
    static func tokens(from raw: String) -> [String] {
        let lowered = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lowered.isEmpty else { return [] }
        return lowered
            .split { ch in
                !(ch.isLetter || ch.isNumber || ch == "-" || ch == "_" || ch == ".")
            }
            .map(String.init)
            .filter { !$0.isEmpty }
    }

    /// True when every token appears somewhere in summary fields (AND).
    static func matchesLocal(_ s: SessionSummary, query: String) -> Bool {
        let toks = tokens(from: query)
        if toks.isEmpty {
            return !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && localHaystack(s).contains(query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        }
        let hay = localHaystack(s)
        return toks.allSatisfy { hay.contains($0) }
    }

    static func matchesLocal(_ s: SessionSummary, tokens toks: [String]) -> Bool {
        guard !toks.isEmpty else { return true }
        let hay = localHaystack(s)
        return toks.allSatisfy { hay.contains($0) }
    }

    static func localHaystack(_ s: SessionSummary) -> String {
        [
            s.title,
            s.prompt,
            s.cwd,
            s.transcriptPreview,
            s.profileName,
            s.profileId,
            s.model,
            s.error,
            s.status.label,
            s.status.rawValue,
            s.backend,
            s.projectId,
            s.grokSessionId,
            s.claudeSessionId,
        ]
        .compactMap { $0?.lowercased() }
        .joined(separator: "\n")
    }

    /// Merge host hits + local pool matches; prefer host row when ids collide.
    static func mergeHits(
        hostHits: [SessionSummary]?,
        localPool: [SessionSummary],
        query: String
    ) -> [SessionSummary] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }

        var byId: [String: SessionSummary] = [:]
        for s in localPool where matchesLocal(s, query: q) {
            byId[s.id] = s
        }
        if let hostHits {
            for s in hostHits {
                byId[s.id] = s
            }
        }
        return byId.values.sorted { $0.updatedAt > $1.updatedAt }
    }
}
