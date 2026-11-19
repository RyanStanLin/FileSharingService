import AppKit
import CoreGraphics
import Foundation
import UserNotifications

@MainActor
final class DeviceInteractions: NSObject, UNUserNotificationCenterDelegate {
    private static let symbols = [
        "info": "info.circle.fill", "warning": "exclamationmark.triangle.fill",
        "question": "questionmark.circle.fill", "stop": "hand.raised.fill"
    ]
    private var dialogInProgress = false
    private var lastNotification: ContinuousClock.Instant?

    func present(_ input: JSON, from origin: URL) async throws -> JSON {
        #if FILESHARING_APP
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        guard session?[kCGSessionOnConsoleKey as String] as? Bool == true,
              session?["CGSSessionScreenIsLocked"] as? Bool != true else {
            throw AgentError("interactive_session_required")
        }
        guard !dialogInProgress else { throw AgentError("limit_reached") }
        let title = try input.requireString("title")
        let message = try input.requireString("message")
        guard title.utf16.count <= 100, message.utf16.count <= 1000,
              let choices = input["choices"].array, (1...3).contains(choices.count),
              let symbol = Self.symbols[try input.requireString("icon")],
              let seconds = input["timeoutSeconds"].int, (10...120).contains(seconds) else {
            throw AgentError("invalid_request")
        }
        let options = try choices.map { choice in
            let id = try choice.requireString("id")
            let label = try choice.requireString("label")
            guard (1...32).contains(id.utf16.count), (1...40).contains(label.utf16.count) else {
                throw AgentError("invalid_request")
            }
            return (id, label)
        }
        let presentation = ManagedDialog(title: title, message: message, symbol: symbol, origin: origin,
                                         options: options, askText: input["askText"].bool == true,
                                         textRequired: input["textRequired"].bool == true)
        dialogInProgress = true
        defer { dialogInProgress = false }
        return try await presentation.show(for: .seconds(seconds))
        #else
        throw AgentError("unsupported")
        #endif
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

#if FILESHARING_APP
@MainActor
private final class ManagedDialog: NSObject, NSTextFieldDelegate {
    private let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 100),
                                  styleMask: [.titled], backing: .buffered, defer: false)
    private let alert = NSAlert()
    private let options: [(id: String, label: String)]
    private let textRequired: Bool
    private var explanation: NSTextField?
    private var outcome = "dismissed"

    init(title: String, message: String, symbol: String, origin: URL,
         options: [(String, String)], askText: Bool, textRequired: Bool) {
        self.options = options
        self.textRequired = textRequired
        super.init()
        parent.title = "FileSharingService"
        parent.isReleasedWhenClosed = false
        alert.messageText = "FileSharingService 管理请求"
        alert.informativeText = "管理服务：\(origin.absoluteString)\n\n\(title)\n\(message)\n\n回复将发送到此管理服务。请勿输入密码或验证码。"
        alert.icon = NSImage(systemSymbolName: symbol, accessibilityDescription: "管理请求")
        for option in options { alert.addButton(withTitle: option.1).keyEquivalent = "" }
        alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
        if askText {
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 26))
            field.placeholderString = "原因或说明"
            field.delegate = self
            alert.accessoryView = field
            explanation = field
            controlTextDidChange(Foundation.Notification(name: NSControl.textDidChangeNotification, object: field))
        }
    }

    func show(for duration: Duration) async throws -> JSON {
        try Task.checkCancellation()
        let workspace = NSWorkspace.shared.notificationCenter
        let distributed = DistributedNotificationCenter.default()
        let lock = distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.dismiss(as: "dismissed") }
        }
        let inactive = workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.dismiss(as: "dismissed") }
        }
        let timer = Task {
            do {
                try await Task.sleep(for: duration)
                dismiss(as: "expired")
            } catch {}
        }
        defer {
            timer.cancel()
            workspace.removeObserver(inactive)
            distributed.removeObserver(lock)
            parent.orderOut(nil)
        }
        parent.center()
        parent.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate()
        let result = await withTaskCancellationHandler {
            await alert.beginSheetModal(for: parent)
        } onCancel: {
            Task { @MainActor in self.dismiss(as: "dismissed") }
        }
        try Task.checkCancellation()
        let index = result.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        let submitted = options.indices.contains(index)
        let text = explanation?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["outcome": .string(submitted ? "submitted" : outcome),
                "choiceId": submitted ? .string(options[index].id) : .null,
                "text": submitted ? .text(text) : .null, "respondedAt": .date(Date())]
    }

    func controlTextDidChange(_ notification: Foundation.Notification) {
        guard let field = notification.object as? NSTextField else { return }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let valid = text.utf16.count <= 1024 && (!textRequired || !text.isEmpty)
        for button in alert.buttons.prefix(options.count) { button.isEnabled = valid }
    }

    private func dismiss(as outcome: String) {
        self.outcome = outcome
        if let sheet = parent.attachedSheet { parent.endSheet(sheet, returnCode: .abort) }
    }
}
#endif
