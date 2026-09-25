import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

/// Attachments list for a project inside the editor's Form. Shows thumbnails
/// for image mime types and a metadata row for everything else. Add via the
/// PhotosPicker (iOS) or file picker (both platforms); swipe or context-menu
/// to delete. Refreshes from the host after any mutation.
struct ProjectAttachmentsSection: View {
    let project: ProjectInfo
    let host: HostEndpoint

    @EnvironmentObject private var appState: AppState
    @State private var attachments: [ProjectAttachment] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    // Upload state
    @State private var isUploading = false
    @State private var uploadProgress: String? = nil
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @State private var showFileImporter = false

    var body: some View {
        Section {
            if isLoading && attachments.isEmpty {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Loading attachments…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if attachments.isEmpty {
                Text("No attachments yet. When you send a screenshot in a session under this project, it lands here automatically.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(attachments) { att in
                    attachmentRow(att)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { await delete(att) }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await delete(att) }
                            } label: {
                                Label("Delete attachment", systemImage: "trash")
                            }
                        }
                }
            }
            if let err = errorMessage {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(DispatchColors.danger)
            }
        } header: {
            HStack {
                Text("Attachments")
                Spacer()
                if isUploading {
                    ProgressView().controlSize(.small)
                    if let p = uploadProgress {
                        Text(p).font(.caption2).foregroundStyle(.secondary)
                    }
                } else if !attachments.isEmpty {
                    Text("\(attachments.count) file\(attachments.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                #if os(iOS)
                PhotosPicker(
                    selection: $photoPickerItems,
                    maxSelectionCount: 6,
                    matching: .images
                ) {
                    Image(systemName: "photo.badge.plus").font(.caption)
                }
                .disabled(isUploading)
                #endif
                Button {
                    showFileImporter = true
                } label: {
                    Image(systemName: "doc.badge.plus").font(.caption)
                }
                .buttonStyle(.plain)
                .disabled(isUploading)
                Button {
                    Task { await reload() }
                } label: {
                    Image(systemName: "arrow.clockwise").font(.caption2)
                }
                .buttonStyle(.plain)
                .disabled(isLoading || isUploading)
            }
        } footer: {
            Text("Sessions in this project can reference these files. Screenshots sent as follow-ups land here automatically; you can also add photos or files directly.")
                .font(.caption2)
        }
        .onChange(of: photoPickerItems) { _, new in
            guard !new.isEmpty else { return }
            let items = new
            photoPickerItems = []
            Task { await uploadPhotoItems(items) }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.data, .image, .plainText, .pdf, .json],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                Task { await uploadFileUrls(urls) }
            case .failure(let err):
                errorMessage = err.localizedDescription
            }
        }
        .onAppear {
            // Prime from the project we were opened with, then refresh from
            // the wire in case the host has newer state.
            attachments = project.attachments ?? []
            Task { await reload() }
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func attachmentRow(_ att: ProjectAttachment) -> some View {
        HStack(spacing: 10) {
            AttachmentThumbnail(
                projectId: project.id,
                attachmentId: att.id,
                mimeType: att.mimeType,
                host: host
            )
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(att.originalName ?? att.filename)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Text(att.mimeType)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(formatBytes(att.sizeBytes))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let src = att.fromSessionId, !src.isEmpty {
                        Text("from session")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Data

    private func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await appState.api.projects(host: host)
            if let p = res.projects.first(where: { $0.id == project.id }) {
                attachments = p.attachments ?? []
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ att: ProjectAttachment) async {
        do {
            try await appState.api.deleteProjectAttachment(
                projectId: project.id,
                attachmentId: att.id,
                host: host
            )
            attachments.removeAll { $0.id == att.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func formatBytes(_ n: Int) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: Int64(n))
    }

    // MARK: - Upload

    private func uploadPhotoItems(_ items: [PhotosPickerItem]) async {
        isUploading = true
        defer {
            isUploading = false
            uploadProgress = nil
        }
        var idx = 0
        var uploaded = 0
        for item in items {
            idx += 1
            uploadProgress = "\(idx)/\(items.count)"
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                // PHPickerResult doesn't hand us a filename or mime type reliably; guess.
                let ext = detectImageExtension(from: data) ?? "jpg"
                let mime = mimeForExtension(ext)
                let filename = "photo-\(shortId()).\(ext)"
                _ = try await appState.api.uploadProjectAttachment(
                    projectId: project.id,
                    data: data,
                    mimeType: mime,
                    filename: filename,
                    originalName: filename,
                    host: host
                )
                uploaded += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        if uploaded > 0 { await reload() }
    }

    private func uploadFileUrls(_ urls: [URL]) async {
        isUploading = true
        defer {
            isUploading = false
            uploadProgress = nil
        }
        var idx = 0
        var uploaded = 0
        for url in urls {
            idx += 1
            uploadProgress = "\(idx)/\(urls.count)"
            // Security-scoped resource for iOS/Mac document picker URLs.
            let needsScope = url.startAccessingSecurityScopedResource()
            defer { if needsScope { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                let ext = url.pathExtension.lowercased()
                let mime = mimeForExtension(ext)
                _ = try await appState.api.uploadProjectAttachment(
                    projectId: project.id,
                    data: data,
                    mimeType: mime,
                    filename: nil,
                    originalName: url.lastPathComponent,
                    host: host
                )
                uploaded += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        if uploaded > 0 { await reload() }
    }

    private func shortId() -> String {
        String(UUID().uuidString.prefix(8)).lowercased()
    }

    /// Best-effort image format sniff from magic bytes so we don't send
    /// everything as image/jpeg.
    private func detectImageExtension(from data: Data) -> String? {
        guard data.count >= 4 else { return nil }
        let b = [UInt8](data.prefix(12))
        // PNG
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "png" }
        // JPEG
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
        // GIF
        if b.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "gif" }
        // WEBP (RIFF ... WEBP)
        if b.count >= 12,
           b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46,
           b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 {
            return "webp"
        }
        // HEIC / HEIF
        if b.count >= 12, b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70,
           b[8] == 0x68, b[9] == 0x65, b[10] == 0x69, b[11] == 0x63 {
            return "heic"
        }
        return nil
    }

    private func mimeForExtension(_ ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "pdf": return "application/pdf"
        case "json": return "application/json"
        case "txt", "md", "markdown": return "text/plain"
        case "html", "htm": return "text/html"
        case "csv": return "text/csv"
        case "xml": return "application/xml"
        case "svg": return "image/svg+xml"
        default:
            if let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }
}

/// Fetches attachment bytes lazily and renders as an Image when the mime
/// type is an image; otherwise shows a document icon.
private struct AttachmentThumbnail: View {
    let projectId: String
    let attachmentId: String
    let mimeType: String
    let host: HostEndpoint

    @EnvironmentObject private var appState: AppState
    @State private var image: PlatformImage?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.06))
            if let img = image {
                #if canImport(UIKit)
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                #else
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                #endif
            } else if isLoading {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: iconName)
                    .foregroundStyle(.secondary)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .task { await load() }
    }

    private var iconName: String {
        let m = mimeType.lowercased()
        if m.contains("pdf") { return "doc.richtext" }
        if m.contains("text") || m.contains("json") { return "doc.plaintext" }
        return "doc"
    }

    private func load() async {
        guard image == nil, mimeType.lowercased().hasPrefix("image/") else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let data = try await appState.api.fetchProjectAttachment(
                projectId: projectId,
                attachmentId: attachmentId,
                host: host
            )
            #if canImport(UIKit)
            image = UIImage(data: data)
            #else
            image = NSImage(data: data)
            #endif
        } catch {
            // Silent — icon fallback stays visible.
        }
    }
}
