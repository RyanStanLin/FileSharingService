#if FILESHARING_APP
import AppKit
import CoreGraphics
import Darwin
import Foundation
import LocalAuthentication

private struct DialogField {
    let id: String?
    let hintText: String?
    let defaultText: String
    let disabled: Bool
    let required: Bool
    let maskText: Bool

    static func configured(_ value: JSON) throws -> [DialogField] {
        guard let fields = value.array, (1...6).contains(fields.count) else { throw AgentError("invalid_request") }
        var ids = Set<String>()
        return try fields.map { field in
            let id = try field.requireString("id")
            let hint = try text(field["hintText"], maximum: 120)
            let initial = try text(field["defaultText"], maximum: 1024) ?? ""
            guard (1...32).contains(id.utf8.count), id.utf8.allSatisfy({
                (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
            }), ids.insert(id).inserted else { throw AgentError("invalid_request") }
            return DialogField(id: id, hintText: hint, defaultText: initial, disabled: try flag(field["disabled"]),
                               required: try flag(field["required"]), maskText: try flag(field["maskText"]))
        }
    }

    private static func text(_ value: JSON, maximum: Int) throws -> String? {
        if value == .null { return nil }
        guard let string = value.string, validText(string, maximum: maximum) else { throw AgentError("invalid_request") }
        return string
    }

    private static func flag(_ value: JSON) throws -> Bool {
        if value == .null { return false }
        guard let flag = value.bool else { throw AgentError("invalid_request") }
        return flag
    }

    static func validText(_ value: String, maximum: Int) -> Bool {
        value.utf16.count <= maximum && !value.unicodeScalars.contains { $0.properties.generalCategory == .control }
    }
}

@MainActor
final class NativeDialog: NSObject, NSTextFieldDelegate {
    private let alert = NSAlert()
    private let options: [(id: String, label: String)]
    private let requireAuthentication: Bool
    private let isForm: Bool
    private let inputs: [(field: DialogField, control: NSTextField)]
    private var authentication: LAContext?
    private var interruption: String?

    static func serve() async {
        let parent = getppid()
        let reply: JSON
        do {
            guard parent > 1 else { throw AgentError("invalid_request") }
            let bytes = try DialogProcess.readFrame(FileHandle.standardInput)
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
        let isForm = input["textFields"] != .null
        guard (1...100).contains(title.utf16.count), (1...1000).contains(message.utf16.count),
              let choices = input["choices"].array, (1...3).contains(choices.count),
              let seconds = input["timeoutSeconds"].int, (10...120).contains(seconds),
              (!(textRequired || maskText) || askText), !(askText && requireAuthentication),
              !(isForm && (askText || requireAuthentication)) else {
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
        let fields: [DialogField]
        if isForm {
            fields = try DialogField.configured(input["textFields"])
        } else {
            fields = askText ? [DialogField(id: nil, hintText: nil, defaultText: "", disabled: false,
                                            required: textRequired, maskText: maskText)] : []
        }
        return try await NativeDialog(title: title, message: message, options: options, fields: fields,
                                      isForm: isForm, requireAuthentication: requireAuthentication)
            .show(for: .seconds(seconds), parent: parent)
    }

    private init(title: String, message: String, options: [(String, String)], fields: [DialogField], isForm: Bool,
                 requireAuthentication: Bool) {
        self.options = options
        self.isForm = isForm
        self.requireAuthentication = requireAuthentication
        self.inputs = fields.map { field in
            let control = field.maskText ? NSSecureTextField(string: field.defaultText) : NSTextField(string: field.defaultText)
            return (field, control)
        }
        super.init()

        alert.alertStyle = .informational
        alert.messageText = title
        alert.informativeText = message
        alert.icon = NSApplication.shared.applicationIconImage
        configureAccessory()
        for (index, option) in options.enumerated() {
            alert.addButton(withTitle: option.1).keyEquivalent = index == 0 ? "\r" : ""
        }
        updateButtons()
    }

    private func configureAccessory() {
        guard !inputs.isEmpty else { return }
        let accessoryWidth: CGFloat = 212
        let spacing: CGFloat = 14
        for (field, control) in inputs {
            control.delegate = self
            control.isEnabled = !field.disabled
            control.isEditable = !field.disabled
            control.isSelectable = !field.disabled
            control.placeholderString = field.hintText
            let label = field.hintText.flatMap { $0.isEmpty ? nil : $0 } ?? field.id ?? (field.maskText ? "企业审批码" : "说明")
            control.setAccessibilityLabel(label)
            control.sizeToFit()
        }
        let height = inputs.reduce(spacing * CGFloat(inputs.count - 1)) { $0 + $1.control.frame.height }
        let form = NSView(frame: NSRect(x: 0, y: 0, width: accessoryWidth, height: height))
        var y = form.bounds.maxY
        for (_, control) in inputs {
            let fieldHeight = control.frame.height
            y -= fieldHeight
            control.frame = NSRect(x: form.bounds.minX, y: y, width: form.bounds.width, height: fieldHeight)
            control.autoresizingMask = .width
            form.addSubview(control)
            y -= spacing
        }
        alert.accessoryView = form
    }

    private static var hasInteractiveSession: Bool {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return session?[kCGSessionOnConsoleKey as String] as? Bool == true &&
            session?["CGSSessionScreenIsLocked"] as? Bool != true
    }

    private func runAlert() -> NSApplication.ModalResponse {
        alert.layout()
        let app = NSApplication.shared
        let window = alert.window
        window.hidesOnDeactivate = false
        window.level = .modalPanel
        window.collectionBehavior = [.moveToActiveSpace, .canJoinAllApplications]
        if let entry = inputs.first(where: { !$0.field.disabled }) { window.initialFirstResponder = entry.control }
        let pointer = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main {
            let frame = window.frame
            window.setFrameOrigin(NSPoint(x: screen.frame.midX - frame.width / 2, y: screen.frame.midY - frame.height / 2))
        }
        let escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.charactersIgnoringModifiers == "\u{1b}", event.window === window, app.modalWindow === window else { return event }
            app.stopModal(withCode: .cancel)
            return nil
        }
        defer {
            if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
            window.orderOut(nil)
        }
        app.activate()
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
                if isForm {
                    let values = Dictionary(uniqueKeysWithValues: inputs.compactMap { field, control -> (String, JSON)? in
                        guard !field.disabled, let id = field.id else { return nil }
                        return (id, .string(inputValue(field, control)))
                    })
                    return DialogProcess.outcome("submitted", choice: id, textValues: values)
                }
                let text = inputs.first.map { inputValue($0.field, $0.control) }
                return DialogProcess.outcome("submitted", choice: id, text: text)
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

    private func inputValue(_ field: DialogField, _ control: NSTextField) -> String {
        let value = control.currentEditor()?.string ?? control.stringValue
        return isForm || field.maskText ? value : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isInputValid: Bool {
        inputs.allSatisfy { field, control in
            if field.disabled { return true }
            let value = inputValue(field, control)
            guard !field.required || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            if isForm { return DialogField.validText(value, maximum: 1024) }
            return value.utf16.count <= 1024 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        }
    }

    private func updateButtons() {
        let enabled = isInputValid
        for button in alert.buttons { button.isEnabled = enabled }
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
