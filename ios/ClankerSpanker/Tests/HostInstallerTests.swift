import XCTest
@testable import ClankerSpankerMac

/// RFC-063: Install / update must never wipe the live host. These run against
/// temp dirs only — no npm, no launchctl, nothing under ~/Library.
final class HostInstallerTests: XCTestCase {
    private var tmp: URL!
    private var root: URL!
    private var source: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        tmp = fm.temporaryDirectory.appendingPathComponent("HostInstallerTests-\(UUID().uuidString)")
        root = tmp.appendingPathComponent("Application Support/ClankerSpanker/host")
        source = tmp.appendingPathComponent("checkout/host")
        try writePackage(at: root, version: "old")
        try fm.createDirectory(at: root.appendingPathComponent("node_modules/dep"), withIntermediateDirectories: true)
        try "keep".write(to: root.appendingPathComponent("unrelated.txt"), atomically: true, encoding: .utf8)
        try writePackage(at: source, version: "new")
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: tmp)
    }

    // MARK: - same-path refusal

    func testIsInsideMatchesRootSubfoldersTrailingSlashAndDots() {
        XCTAssertTrue(HostInstaller.isInside(root.path, root: root))
        XCTAssertTrue(HostInstaller.isInside(root.path + "/", root: root))
        XCTAssertTrue(HostInstaller.isInside(root.appendingPathComponent("dist").path, root: root))
        XCTAssertTrue(HostInstaller.isInside(root.path + "/../host", root: root))
        XCTAssertFalse(HostInstaller.isInside(source.path, root: root))
        // A sibling that shares a name prefix is not inside.
        XCTAssertFalse(HostInstaller.isInside(root.path + "-old", root: root))
    }

    func testIsInsideFollowsSymlinks() throws {
        let link = tmp.appendingPathComponent("link-to-install")
        try fm.createSymbolicLink(at: link, withDestinationURL: root)
        XCTAssertTrue(HostInstaller.isInside(link.path, root: root))
    }

    func testInstallRootPathIsNeverASource() {
        let installed = LocalHostConfigFile.installedHostRoot.path
        XCTAssertTrue(HostInstaller.isInstallRootPath(installed))
        XCTAssertTrue(HostInstaller.isInstallRootPath("~/Library/Application Support/ClankerSpanker/host"))
        XCTAssertFalse(HostInstaller.isInstallRootPath(""))
        XCTAssertFalse(HostInstaller.isInstallRootPath("~/Projects/ClankerSpanker/host"))
    }

    func testDeployFromInstallRootRefusesAndDeletesNothing() throws {
        var prepared = false
        XCTAssertThrowsError(try HostInstaller.deploy(from: root, to: root, prepare: { _ in prepared = true })) { error in
            XCTAssertTrue(error.localizedDescription.contains("checkout's host/ folder"), error.localizedDescription)
        }
        XCTAssertFalse(prepared)
        try assertOldInstallIntact()
    }

    func testDeployFromInsideInstallRootRefuses() throws {
        XCTAssertThrowsError(try HostInstaller.deploy(from: root.appendingPathComponent("dist"), to: root))
        try assertOldInstallIntact()
    }

    // MARK: - staged swap

    func testFailedCopyKeepsOldInstall() throws {
        try fm.removeItem(at: source.appendingPathComponent("dist"))
        XCTAssertThrowsError(try HostInstaller.deploy(from: source, to: root))
        try assertOldInstallIntact()
        try assertNoStagingLeftovers()
    }

    func testFailedPrepareKeepsOldInstall() throws {
        struct NpmFailed: Error {}
        XCTAssertThrowsError(try HostInstaller.deploy(from: source, to: root, prepare: { _ in throw NpmFailed() }))
        try assertOldInstallIntact()
        try assertNoStagingLeftovers()
    }

    func testSuccessfulDeploySwapsPackageAndKeepsOtherFiles() throws {
        try HostInstaller.deploy(from: source, to: root, prepare: { staged in
            // Stands in for `npm install --omit=dev`, which runs in staging.
            try self.fm.createDirectory(at: staged.appendingPathComponent("node_modules/fresh"), withIntermediateDirectories: true)
        })
        XCTAssertEqual(try version(at: root), "new")
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("web/index.html").path))
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("node_modules/fresh").path))
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("node_modules/dep").path))
        XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent("unrelated.txt").path))
        try assertNoStagingLeftovers()
    }

    func testDeployIntoMissingInstallRootCreatesIt() throws {
        try fm.removeItem(at: root)
        try HostInstaller.deploy(from: source, to: root)
        XCTAssertEqual(try version(at: root), "new")
    }

    // MARK: - helpers

    private func writePackage(at dir: URL, version: String) throws {
        try fm.createDirectory(at: dir.appendingPathComponent("dist"), withIntermediateDirectories: true)
        try fm.createDirectory(at: dir.appendingPathComponent("web"), withIntermediateDirectories: true)
        try "// \(version)".write(to: dir.appendingPathComponent("dist/index.js"), atomically: true, encoding: .utf8)
        try "<p>\(version)</p>".write(to: dir.appendingPathComponent("web/index.html"), atomically: true, encoding: .utf8)
        try #"{"version":"\#(version)"}"#.write(to: dir.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        try "{}".write(to: dir.appendingPathComponent("package-lock.json"), atomically: true, encoding: .utf8)
    }

    private func version(at dir: URL) throws -> String {
        try String(contentsOf: dir.appendingPathComponent("dist/index.js"), encoding: .utf8)
            .replacingOccurrences(of: "// ", with: "")
    }

    private func assertOldInstallIntact(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try version(at: root), "old", file: file, line: line)
        for name in ["web/index.html", "package.json", "package-lock.json", "node_modules/dep", "unrelated.txt"] {
            XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent(name).path), "missing \(name)", file: file, line: line)
        }
    }

    private func assertNoStagingLeftovers(file: StaticString = #filePath, line: UInt = #line) throws {
        let siblings = try fm.contentsOfDirectory(atPath: root.deletingLastPathComponent().path)
        XCTAssertEqual(siblings, ["host"], file: file, line: line)
    }
}
