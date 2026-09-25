import XCTest
@testable import ClankerSpankerMac

/// Wire compatibility for fields added today: new clients must decode old
/// hosts (fields absent) and new hosts (fields present).
final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testUnknownSessionStatusDoesNotFailDecoding() throws {
        XCTAssertEqual(try decode([SessionStatus].self, #"["running","future_state"]"#), [.running, .unknown])
    }

    func testApprovalPreviewDiffAndCommand() throws {
        let diff = try decode(ApprovalPreview.self, #"{"type":"diff","path":"/r/calc.py","oldText":"a - b","newText":"a + b","truncated":false}"#)
        XCTAssertEqual(diff.type, "diff")
        XCTAssertEqual(diff.newText, "a + b")
        let cmd = try decode(ApprovalPreview.self, #"{"type":"command","command":"python3 -m pytest","truncated":true}"#)
        XCTAssertEqual(cmd.command, "python3 -m pytest")
        XCTAssertEqual(cmd.truncated, true)
    }

    func testToolCallRecordOutputFieldsAreOptional() throws {
        let old = try decode(ToolCallRecord.self, #"{"toolCallId":"c","title":"t","status":"completed","updatedAt":"2026-09-25T00:00:00Z"}"#)
        XCTAssertNil(old.outputPreview)
        let new = try decode(ToolCallRecord.self, #"{"toolCallId":"c","title":"t","status":"completed","updatedAt":"2026-09-25T00:00:00Z","outputPreview":"No module named pytest","exitCode":1}"#)
        XCTAssertEqual(new.exitCode, 1)
        XCTAssertEqual(new.outputPreview, "No module named pytest")
    }

    func testAgentProfileAutoApproveFlagIsOptional() throws {
        let old = try decode(AgentProfile.self, ##"{"id":"g","name":"Gemini","backend":"antigravity","color":"#0f0"}"##)
        XCTAssertNil(old.autoApprovesTools)
        let new = try decode(AgentProfile.self, ##"{"id":"g","name":"Gemini","backend":"antigravity","color":"#0f0","autoApprovesTools":true}"##)
        XCTAssertEqual(new.autoApprovesTools, true)
    }

    func testOnboardingDefaultsCarryNoLANAddress() {
        XCTAssertFalse(ConnectionDefaults.hostURLPlaceholder.contains("192.168"))
        XCTAssertEqual(ConnectionDefaults.setupPageURL.host, "localhost")
    }
}
