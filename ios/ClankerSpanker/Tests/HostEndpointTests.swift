import XCTest
@testable import ClankerSpankerMac

/// RFC-046: first Swift tests. Host identity is what multi-host routing and
/// QR re-pairing (RFC-024/026/035) hang on.
final class HostEndpointTests: XCTestCase {
    func testNormalizeBaseURLDropsPathQueryAndTrailingSlash() {
        XCTAssertEqual(HostEndpoint.normalizeBaseURL(" http://100.66.33.89:8787/setup?x=1 "), "http://100.66.33.89:8787")
        // Case is kept here; matching is case-insensitive via endpointKey.
        XCTAssertEqual(HostEndpoint.normalizeBaseURL("http://Mac-Mini.local:8787/"), "http://Mac-Mini.local:8787")
    }

    func testEndpointKeyIsCaseInsensitiveAndFillsDefaultPort() {
        XCTAssertEqual(HostEndpoint(name: "a", baseURL: "http://MAC.local:8787").endpointKey, "mac.local:8787")
        XCTAssertEqual(HostEndpoint(name: "a", baseURL: "https://host.ts.net").endpointKey, "host.ts.net:443")
        XCTAssertEqual(HostEndpoint(name: "a", baseURL: "http://host").endpointKey, "host:80")
    }

    func testConfigureLinkMatchesExistingHostByAddress() {
        let primary = HostEndpoint(name: "Primary", baseURL: "http://100.66.33.89:8787")
        let astrodata = HostEndpoint(name: "Astrodata", baseURL: "http://100.66.166.28:8787")
        let rescan = HostEndpoint(name: "alexs-mac-mini", baseURL: "http://100.66.33.89:8787/")
        XCTAssertEqual(AppState.existingHost(matching: rescan, in: [primary, astrodata])?.id, primary.id)

        let newHost = HostEndpoint(name: "new", baseURL: "http://100.70.1.1:8787")
        XCTAssertNil(AppState.existingHost(matching: newHost, in: [primary, astrodata]))
    }
}
