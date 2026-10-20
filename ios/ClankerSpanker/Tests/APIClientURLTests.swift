import XCTest
@testable import ClankerSpankerMac

/// joinURL used to put `?since=N` into URLComponents.path, which sent
/// `/events%3Fsince=N` and got a 404 on every reconnect catch-up.
final class APIClientURLTests: XCTestCase {
    private let base = URL(string: "http://100.64.0.10:8787")!

    func testPlainPath() throws {
        let url = try APIClient.joinURL(base: base, path: "/sessions")
        XCTAssertEqual(url.absoluteString, "http://100.64.0.10:8787/sessions")
        let noSlash = try APIClient.joinURL(base: base, path: "sessions")
        XCTAssertEqual(noSlash.absoluteString, "http://100.64.0.10:8787/sessions")
    }

    func testQueryInPathIsNotPercentEncoded() throws {
        let url = try APIClient.joinURL(base: base, path: "/sessions/abc/events?since=57")
        XCTAssertEqual(url.absoluteString, "http://100.64.0.10:8787/sessions/abc/events?since=57")
        XCTAssertFalse(url.absoluteString.contains("%3F"))
        XCTAssertEqual(url.path, "/sessions/abc/events")
    }

    func testBaseURLWithPathPrefix() throws {
        let prefixed = URL(string: "https://host.ts.net/gateway/")!
        let url = try APIClient.joinURL(base: prefixed, path: "/projects/p1?hard=1")
        XCTAssertEqual(url.absoluteString, "https://host.ts.net/gateway/projects/p1?hard=1")
    }

    func testExplicitQueryItemsMergeAndWinOnConflict() throws {
        let url = try APIClient.joinURL(
            base: base,
            path: "/tasks?status=open&since=1",
            queryItems: [URLQueryItem(name: "since", value: "9"), URLQueryItem(name: "fetch", value: "1")]
        )
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items, [
            URLQueryItem(name: "status", value: "open"),
            URLQueryItem(name: "since", value: "9"),
            URLQueryItem(name: "fetch", value: "1"),
        ])
    }

    func testExplicitQueryItemsOnly() throws {
        let url = try APIClient.joinURL(
            base: base,
            path: "/sessions/abc/events",
            queryItems: [URLQueryItem(name: "since", value: "57")]
        )
        XCTAssertEqual(url.absoluteString, "http://100.64.0.10:8787/sessions/abc/events?since=57")
    }

    func testSessionIdIsPathEncoded() throws {
        let url = try APIClient.joinURL(base: base, path: "/sessions/a b#c/events?since=3")
        XCTAssertEqual(url.absoluteString, "http://100.64.0.10:8787/sessions/a%20b%23c/events?since=3")
        XCTAssertEqual(url.query, "since=3")
    }
}
