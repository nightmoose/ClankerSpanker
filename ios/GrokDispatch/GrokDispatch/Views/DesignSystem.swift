import SwiftUI

enum DispatchColors {
    static let accent = Color(red: 0.45, green: 0.72, blue: 1.0)
    static let accentSecondary = Color(red: 0.72, green: 0.45, blue: 1.0)
    static let danger = Color(red: 1.0, green: 0.35, blue: 0.4)
    static let success = Color(red: 0.35, green: 0.85, blue: 0.55)
    static let warning = Color(red: 1.0, green: 0.75, blue: 0.3)
    static let card = Color.white.opacity(0.06)
    static let cardStroke = Color.white.opacity(0.1)
}

struct DispatchBackground: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            RadialGradient(
                colors: [Color(red: 0.08, green: 0.18, blue: 0.35).opacity(0.7), .clear],
                center: .topLeading,
                startRadius: 0,
                endRadius: 420
            )
            .ignoresSafeArea()
            RadialGradient(
                colors: [Color(red: 0.25, green: 0.05, blue: 0.35).opacity(0.45), .clear],
                center: .bottomTrailing,
                startRadius: 0,
                endRadius: 360
            )
            .ignoresSafeArea()
        }
    }
}

struct DispatchCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .background(DispatchColors.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(DispatchColors.cardStroke, lineWidth: 1)
            )
    }
}

struct DispatchButton: View {
    enum Style { case primary, secondary, danger, ghost }

    let title: String
    var icon: String? = nil
    var style: Style = .primary
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView().tint(foreground)
                } else if let icon {
                    Image(systemName: icon)
                }
                Text(title).fontWeight(.semibold)
            }
            .font(.body)
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(border, lineWidth: style == .secondary || style == .ghost ? 1.2 : 0)
            )
        }
        .disabled(isLoading)
    }

    private var foreground: Color {
        switch style {
        case .primary: return .black
        case .secondary, .ghost: return .white
        case .danger: return .white
        }
    }

    private var background: some ShapeStyle {
        switch style {
        case .primary: return AnyShapeStyle(DispatchColors.accent)
        case .secondary: return AnyShapeStyle(Color.white.opacity(0.08))
        case .danger: return AnyShapeStyle(DispatchColors.danger)
        case .ghost: return AnyShapeStyle(Color.clear)
        }
    }

    private var border: Color {
        switch style {
        case .secondary: return Color.white.opacity(0.18)
        case .ghost: return Color.white.opacity(0.12)
        default: return .clear
        }
    }
}

struct StatusBadge: View {
    let status: SessionStatus

    var body: some View {
        Label(status.label, systemImage: status.systemImage)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(color)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }

    private var color: Color {
        switch status {
        case .queued: return .gray
        case .running: return DispatchColors.accent
        case .awaitingApproval: return DispatchColors.warning
        case .awaitingQuestion: return DispatchColors.accentSecondary
        case .idle: return DispatchColors.accentSecondary
        case .completed: return DispatchColors.success
        case .failed: return DispatchColors.danger
        case .cancelled, .unknown: return .secondary
        }
    }
}
