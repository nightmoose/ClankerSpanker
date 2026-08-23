import Foundation
import UserNotifications

enum NotificationService {
    /// Category identifier for approval notifications with Approve/Reject action buttons.
    static let approvalCategoryId = "APPROVAL_REQUEST"
    /// Category for question notifications (no inline actions; tap opens the session).
    static let questionCategoryId = "QUESTION_REQUEST"
    static let approveActionId = "APPROVE_ACTION"
    static let rejectActionId = "REJECT_ACTION"

    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        registerCategories()
    }

    static func registerCategories() {
        let approve = UNNotificationAction(
            identifier: approveActionId,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let reject = UNNotificationAction(
            identifier: rejectActionId,
            title: "Reject",
            options: [.destructive]
        )
        let approvalCategory = UNNotificationCategory(
            identifier: approvalCategoryId,
            actions: [approve, reject],
            intentIdentifiers: [],
            options: []
        )
        let questionCategory = UNNotificationCategory(
            identifier: questionCategoryId,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([approvalCategory, questionCategory])
    }

    static func notify(title: String, body: String, id: String = UUID().uuidString) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let req = UNNotificationRequest(
            identifier: id,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    /// Approval notification with Approve/Reject action buttons. The action
    /// handler in AppDelegate routes to AppState via NotificationCenter.
    static func notifyApproval(
        sessionId: String,
        hostId: String,
        approvalId: String,
        sessionTitle: String,
        approvalTitle: String
    ) {
        let content = UNMutableNotificationContent()
        content.title = "Approval needed — \(sessionTitle)"
        content.body = approvalTitle
        content.sound = .default
        content.categoryIdentifier = approvalCategoryId
        content.userInfo = [
            "kind": "approval",
            "sessionId": sessionId,
            "hostId": hostId,
            "approvalId": approvalId,
        ]

        let req = UNNotificationRequest(
            identifier: "approval-\(approvalId)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    static func notifyQuestion(
        sessionId: String,
        hostId: String,
        sessionTitle: String,
        questionTitle: String
    ) {
        let content = UNMutableNotificationContent()
        content.title = "Answers needed — \(sessionTitle)"
        content.body = questionTitle
        content.sound = .default
        content.categoryIdentifier = questionCategoryId
        content.userInfo = [
            "kind": "question",
            "sessionId": sessionId,
            "hostId": hostId,
        ]

        let req = UNNotificationRequest(
            identifier: "question-\(sessionId)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }
}
