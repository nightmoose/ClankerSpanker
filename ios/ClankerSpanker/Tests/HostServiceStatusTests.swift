import XCTest
@testable import ClankerSpankerMac

/// RFC-064: the Host panel's install / LaunchAgent status and the launch-time
/// recovery decision. Temp dirs and fake launchctl only — nothing is loaded.
final class HostServiceStatusTests: XCTestCase {
    private var tmp: URL!
    private var root: URL!
    private var plist: URL!
    private let fm = FileManager.default
    private let appLabel = "test.app-agent"
    private let standaloneLabel = "test.standalone-agent"

    override func setUpWithError() throws {
        tmp = fm.temporaryDirectory.appendingPathComponent("HostServiceStatusTests-\(UUID().uuidString)")
        root = tmp.appendingPathComponent("host")
        plist = tmp.appendingPathComponent("LaunchAgents/\(appLabel).plist")
        try fm.createDirectory(at: root.appendingPathComponent("dist"), withIntermediateDirectories: true)
        try fm.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: tmp)
    }

    // MARK: - recovery decision

    private func status(installed: Bool, plist: Bool, app: Bool, standalone: Bool) -> HostServiceStatus {
        HostServiceStatus(packageInstalled: installed, plistPresent: plist, appAgentLoaded: app, standaloneAgentLoaded: standalone)
    }

    func testInterruptedInstallIsRecovered() {
        // The 2026-10-19 crash: plist rewritten, agent booted out, never bootstrapped.
        XCTAssertEqual(status(installed: true, plist: true, app: false, standalone: false).recovery, .loadAppAgent)
    }

    func testNothingToDoWhenLoaded() {
        XCTAssertEqual(status(installed: true, plist: true, app: true, standalone: false).recovery, .none)
    }

    func testNeverLoadsOverTheStandaloneAgent() {
        // Both bind the same port.
        XCTAssertEqual(status(installed: true, plist: true, app: false, standalone: true).recovery, .none)
    }

    func testNoPlistMeansDeliberatelyUnloaded() {
        // Unload LaunchAgent removes the plist; that must not be undone on launch.
        XCTAssertEqual(status(installed: true, plist: false, app: false, standalone: false).recovery, .none)
    }

    func testNoPackageMeansNothingToLoad() {
        XCTAssertEqual(status(installed: false, plist: true, app: false, standalone: false).recovery, .none)
    }

    func testLoadedAgentLabelPrefersAppAgent() {
        XCTAssertEqual(status(installed: true, plist: true, app: true, standalone: true).loadedAgentLabel,
                       LocalHostConfigFile.launchAgentLabel)
        XCTAssertEqual(status(installed: true, plist: true, app: false, standalone: true).loadedAgentLabel,
                       HostInstaller.standaloneLabel)
        XCTAssertNil(status(installed: true, plist: true, app: false, standalone: false).loadedAgentLabel)
    }

    // MARK: - probe

    func testProbeReadsDiskAndLaunchctl() throws {
        var asked: [String] = []
        func probe(loaded: Set<String>) -> HostServiceStatus {
            HostServiceStatus.probe(
                installRoot: root, plistURL: plist, appLabel: appLabel, standaloneLabel: standaloneLabel,
                isLoaded: { asked.append($0); return loaded.contains($0) }
            )
        }
        XCTAssertEqual(probe(loaded: []), status(installed: false, plist: false, app: false, standalone: false))
        XCTAssertEqual(Set(asked), [appLabel, standaloneLabel])

        try "//".write(to: root.appendingPathComponent("dist/index.js"), atomically: true, encoding: .utf8)
        try "<plist/>".write(to: plist, atomically: true, encoding: .utf8)
        XCTAssertEqual(probe(loaded: []).recovery, .loadAppAgent)
        XCTAssertEqual(probe(loaded: [appLabel]), status(installed: true, plist: true, app: true, standalone: false))
        XCTAssertEqual(probe(loaded: [standaloneLabel]).recovery, .none)
    }

    // MARK: - bootout → bootstrap

    private struct LaunchctlFailed: Error {}

    func testBootstrapRunsBootoutThenBootstrapAndRetries() throws {
        try "<plist/>".write(to: plist, atomically: true, encoding: .utf8)
        var calls: [String] = []
        var bootstrapFailures = 2
        try HostInstaller.bootstrapAgent(
            log: { _ in }, plistURL: plist, label: appLabel, retryDelay: 0,
            runLaunchctl: { args in
                calls.append(args[0])
                if args[0] == "bootout" { throw LaunchctlFailed() } // not loaded: ignored
                if args[0] == "bootstrap", bootstrapFailures > 0 {
                    bootstrapFailures -= 1
                    throw LaunchctlFailed() // launchd still tearing down the old job
                }
            }
        )
        XCTAssertEqual(calls, ["bootout", "bootstrap", "bootstrap", "bootstrap", "enable", "kickstart"])
    }

    func testBootstrapGivesUpAfterAttempts() throws {
        try "<plist/>".write(to: plist, atomically: true, encoding: .utf8)
        var bootstraps = 0
        XCTAssertThrowsError(try HostInstaller.bootstrapAgent(
            log: { _ in }, plistURL: plist, label: appLabel, attempts: 3, retryDelay: 0,
            runLaunchctl: { args in
                if args[0] == "bootstrap" { bootstraps += 1; throw LaunchctlFailed() }
            }
        ))
        XCTAssertEqual(bootstraps, 3)
    }

    func testBootstrapRefusesWithoutPlistAndNeverBootsOut() {
        var calls: [String] = []
        XCTAssertThrowsError(try HostInstaller.bootstrapAgent(
            log: { _ in }, plistURL: plist, label: appLabel, retryDelay: 0,
            runLaunchctl: { calls.append($0[0]) }
        ))
        XCTAssertEqual(calls, [])
    }

    // MARK: - off the main thread

    @MainActor
    func testOffMainRunsOffTheMainThread() async throws {
        let onMain = try await HostInstaller.offMain { Thread.isMainThread }
        XCTAssertFalse(onMain)
    }
}
