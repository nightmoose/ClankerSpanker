import XCTest
@testable import ClankerSpankerMac

/// RFC-038: socket events patch the list row's status immediately.
final class LiveStatusTests: XCTestCase {
    func testApprovalAndQuestionEvents() {
        XCTAssertEqual(AppState.liveStatus(forEvent: "approval.needed", payload: nil), .awaitingApproval)
        XCTAssertEqual(AppState.liveStatus(forEvent: "question.needed", payload: nil), .awaitingQuestion)
        XCTAssertEqual(AppState.liveStatus(forEvent: "approval.resolved", payload: nil), .running)
        XCTAssertEqual(AppState.liveStatus(forEvent: "question.answered", payload: nil), .running)
    }

    func testSessionEventsUseTheirStatusPayload() {
        XCTAssertEqual(AppState.liveStatus(forEvent: "session.updated", payload: ["status": "idle"]), .idle)
        XCTAssertEqual(AppState.liveStatus(forEvent: "session.completed", payload: ["status": "completed"]), .completed)
        XCTAssertEqual(AppState.liveStatus(forEvent: "session.failed", payload: ["status": "failed"]), .failed)
    }

    func testEventsWithoutAStatusChangeNothing() {
        XCTAssertNil(AppState.liveStatus(forEvent: "session.updated", payload: ["title": "x"]))
        XCTAssertNil(AppState.liveStatus(forEvent: "tool_call", payload: nil))
        XCTAssertNil(AppState.liveStatus(forEvent: "session.updated", payload: ["status": "not-a-status"]))
    }
}
