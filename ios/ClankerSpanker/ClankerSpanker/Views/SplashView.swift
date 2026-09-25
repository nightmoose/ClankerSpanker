import SwiftUI

/// One-shot launch splash — shown once per app process (not per foreground)
/// on top of ContentView, holds for ~2s, then fades out. Tap to skip.
///
/// Wired up in ContentView so the splash sits above the real UI while it's
/// visible. Timing matches Apple's "brief, welcoming, non-blocking" bar
/// while still giving a moment to see the mark.
struct SplashView: View {
    var onDismiss: () -> Void

    /// Full 2.0s hold + 0.4s fade. Tap-to-skip triggers the fade immediately.
    private static let holdSeconds: Double = 2.0
    private static let fadeSeconds: Double = 0.4

    @State private var isFading = false
    @State private var startPulse = false

    var body: some View {
        ZStack {
            // Slight background wash so the logo has an anchor on either
            // dark or light desktops (macOS system windows can vary).
            LinearGradient(
                colors: [
                    Color(red: 0.05, green: 0.06, blue: 0.09),
                    Color(red: 0.10, green: 0.11, blue: 0.16),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 18) {
                Image("AppLogo")
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 260, maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 52, style: .continuous))
                    .shadow(color: .black.opacity(0.35), radius: 22, x: 0, y: 10)
                    .scaleEffect(startPulse ? 1.0 : 0.92)
                    .opacity(startPulse ? 1.0 : 0.0)

                Text("ClankerSpanker")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .opacity(startPulse ? 0.9 : 0.0)
            }
        }
        .opacity(isFading ? 0 : 1)
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
        .onAppear {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.72)) {
                startPulse = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdSeconds) {
                dismiss()
            }
        }
    }

    private func dismiss() {
        guard !isFading else { return }
        withAnimation(.easeOut(duration: Self.fadeSeconds)) {
            isFading = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fadeSeconds) {
            onDismiss()
        }
    }
}
