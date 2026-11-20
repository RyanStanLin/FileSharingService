#if FILESHARING_APP
import AppKit
import CoreGraphics
import Darwin
import Foundation
import LocalAuthentication

@MainActor
final class NativeDialog: NSObject, NSTextFieldDelegate {
    private let alert = NSAlert()
    private let options: [(id: String, label: String)]
    private let textRequired: Bool
    private let requireAuthentication: Bool
    private let inputField: NSTextField?
    private var authentication: LAContext?
    private var interruption: String?

    static func serve() async {
        let parent = getppid()
        let reply: JSON
        do {
            guard parent > 1, let bytes = try FileHandle.standardInput.readToEnd(), bytes.count <= 8_192 else {
                throw AgentError("invalid_request")
            }
            reply = ["payload": try await present(JSON.decode(bytes), parent: parent)]
        } catch {
            reply = ["code": .string((error as? AgentError)?.code ?? "dialog_presentation_failed")]
        }
        if let bytes = try? reply.encoded() { try? FileHandle.standardOutput.write(contentsOf: bytes) }
    }

    static func present(_ input: JSON, parent: pid_t? = nil) async throws -> JSON {
        guard hasInteractiveSession else {
            throw AgentError("interactive_session_required")
        }
        let title = try input.requireString("title")
        let message = try input.requireString("message")
        let askText = input["askText"].bool == true
        let maskText = input["maskText"].bool == true
        let textRequired = input["textRequired"].bool == true
        let requireAuthentication = input["requireLocalAuthentication"].bool == true
        guard (1...100).contains(title.utf16.count), (1...1000).contains(message.utf16.count),
              let choices = input["choices"].array, (1...3).contains(choices.count),
              let seconds = input["timeoutSeconds"].int, (10...120).contains(seconds),
              (!(textRequired || maskText) || askText), !(askText && requireAuthentication) else {
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
        return try await NativeDialog(title: title, message: message, options: options, askText: askText, maskText: maskText,
                                      textRequired: textRequired, requireAuthentication: requireAuthentication)
            .show(for: .seconds(seconds), parent: parent)
    }

    private init(title: String, message: String, options: [(String, String)], askText: Bool, maskText: Bool, textRequired: Bool,
                 requireAuthentication: Bool) {
        self.options = options
        self.textRequired = textRequired
        self.requireAuthentication = requireAuthentication
        if maskText {
            self.inputField = NSSecureTextField(string: "")
        } else {
            self.inputField = askText ? NSTextField(string: "") : nil
        }
        super.init()

        alert.alertStyle = .informational
        alert.messageText = title
        alert.informativeText = message
        alert.icon = NSApplication.shared.applicationIconImage
        if let inputField {
            inputField.delegate = self
            inputField.setAccessibilityLabel(maskText ? "企业审批码" : "说明")
            inputField.sizeToFit()
            inputField.frame.size.width = 212
            alert.accessoryView = inputField
        }
        for (index, option) in options.enumerated() {
            alert.addButton(withTitle: option.1).keyEquivalent = index == 0 ? "\r" : ""
        }
        alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
        updateButtons()
    }

    private static var hasInteractiveSession: Bool {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return session?[kCGSessionOnConsoleKey as String] as? Bool == true &&
            session?["CGSSessionScreenIsLocked"] as? Bool != true
    }

    private func runAlert() -> NSApplication.ModalResponse {
        alert.layout()
        let window = alert.window
        window.hidesOnDeactivate = false
        window.level = .modalPanel
        window.collectionBehavior = [.moveToActiveSpace, .canJoinAllApplications]
        if let inputField { window.initialFirstResponder = inputField }
        defer { window.orderOut(nil) }
        NSApplication.shared.activate()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        return alert.runModal()
    }

    private func show(for duration: Duration, parent: pid_t?) async throws -> JSON {
        try Task.checkCancellation()
        let deadline = ContinuousClock.now + duration
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.checkInterruption(deadline: deadline, parent: parent)
            }
        }
        // NSAlert runs a nested loop in the helper. Keep timeout and session checks active in that loop.
        RunLoop.main.add(timer, forMode: .modalPanel)
        RunLoop.main.add(timer, forMode: .default)
        defer { timer.invalidate() }

        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let response = runAlert()
            checkInterruption(deadline: deadline, parent: parent)
            if let interruption { return DialogProcess.outcome(interruption) }

            let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            guard options.indices.contains(index), isInputValid else { return DialogProcess.outcome("dismissed") }
            let id = options[index].id
            if !requireAuthentication {
                return DialogProcess.outcome("submitted", choice: id, text: inputValue)
            }
            let approved = try await authenticate()
            checkInterruption(deadline: deadline, parent: parent)
            if let interruption { return DialogProcess.outcome(interruption) }
            return approved ? DialogProcess.outcome("submitted", choice: id, authenticated: true) : DialogProcess.outcome("dismissed")
        } onCancel: {
            RunLoop.main.perform(inModes: [.modalPanel, .default]) {
                MainActor.assumeIsolated { self.interrupt("dismissed") }
            }
        }
    }

    private func checkInterruption(deadline: ContinuousClock.Instant, parent: pid_t?) {
        if Task.isCancelled {
            interrupt("dismissed")
        } else if ContinuousClock.now >= deadline {
            interrupt("expired")
        } else if parent.map({ getppid() != $0 }) == true || !Self.hasInteractiveSession {
            interrupt("dismissed")
        }
    }

    private func interrupt(_ outcome: String) {
        guard interruption == nil else { return }
        interruption = outcome
        if NSApplication.shared.modalWindow === alert.window { NSApplication.shared.abortModal() }
        authentication?.invalidate()
    }

    func controlTextDidChange(_ notification: Foundation.Notification) { updateButtons() }

    private var inputValue: String? {
        guard let inputField else { return nil }
        let value = inputField.stringValue
        return inputField is NSSecureTextField ? value : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isInputValid: Bool {
        let value = inputValue ?? ""
        return value.utf16.count <= 1024 && (!textRequired || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
            !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private func updateButtons() {
        let enabled = isInputValid
        for button in alert.buttons.dropLast() { button.isEnabled = enabled }
    }

    private func authenticate() async throws -> Bool {
        let context = LAContext()
        context.localizedFallbackTitle = "使用密码"
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            throw AgentError("local_authentication_unavailable")
        }
        authentication = context
        defer {
            context.invalidate()
            authentication = nil
        }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication,
            localizedReason: "确认这台 Mac 上的 FileSharingService 操作。")) == true
    }
}
#endif
