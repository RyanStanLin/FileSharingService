import AppKit
import Foundation
import UserNotifications

@MainActor
final class DeviceInteractions: NSObject, UNUserNotificationCenterDelegate {
    private var lastNotification: ContinuousClock.Instant?

    nonisolated static func present(_ input: JSON) async throws -> JSON {
        #if FILESHARING_APP
        guard let executable = Bundle.main.executableURL else { throw AgentError("dialog_presentation_failed") }
        #elseif FILESHARING_TEST
        guard let helper = ProcessInfo.processInfo.environment["FILESHARING_TEST_DIALOG_HELPER"] else {
            throw AgentError("unsupported")
        }
        let executable = URL(fileURLWithPath: helper)
        #else
        let executable: URL? = nil
        #endif
        return try await DialogProcess.run(executable, input: input)
    }

    func notify(_ input: JSON, id: String, from origin: URL) async throws -> JSON {
        #if FILESHARING_APP
        let title = try input.requireString("title")
        let message = try input.requireString("message")
        guard title.utf16.count <= 100, message.utf16.count <= 500 else { throw AgentError("invalid_request") }
        if let lastNotification, lastNotification.duration(to: .now) < .seconds(5) {
            throw AgentError("limit_reached")
        }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard [.authorized, .provisional].contains(settings.authorizationStatus) else {
            throw AgentError("notification_permission_required")
        }
        try Task.checkCancellation()
        lastNotification = .now
        center.delegate = self
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = "FileSharingService · \(origin.absoluteString)"
        content.body = message
        if input["sound"].bool == true { content.sound = .default }
        try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        return ["status": "scheduled", "scheduledAt": .date(Date())]
        #else
        throw AgentError("unsupported")
        #endif
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                             willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    static func requestNotificationPermission() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }
}
