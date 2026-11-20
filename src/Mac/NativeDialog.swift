#if FILESHARING_APP
import AppKit
import CoreGraphics
import Darwin
import Foundation
import LocalAuthentication

@MainActor
final class NativeDialog: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    private static let width: CGFloat = 260
    private static let margin: CGFloat = 18
    private static let column = width - 2 * margin

    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: NativeDialog.width, height: 300),
                                styleMask: [.titled, .closable], backing: .buffered, defer: false)
    private let options: [(id: String, label: String)]
    private let textRequired: Bool
    private let requireAuthentication: Bool
    private let inputField: NSTextField?
    private var buttons = [NSButton]()
    private var authentication: LAContext?
    private var completion: CheckedContinuation<JSON, Error>?

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
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        guard session?[kCGSessionOnConsoleKey as String] as? Bool == true,
              session?["CGSSessionScreenIsLocked"] as? Bool != true else {
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

        panel.title = "FileSharingService"
        panel.delegate = self
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .modalPanel
        panel.collectionBehavior = [.moveToActiveSpace, .canJoinAllApplications]

        let icon = NSImageView(image: NSApplication.shared.applicationIconImage)
        icon.setAccessibilityElement(false)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 52).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 52).isActive = true
        let heading = Self.label(title, font: .boldSystemFont(ofSize: 15))
        constrain(heading)
        let body = Self.messageView(message)
        constrain(body)
        var content = [icon as NSView, heading, body]
        if let inputField {
            inputField.delegate = self
            inputField.setAccessibilityLabel(maskText ? "企业审批码" : "说明")
            constrain(inputField)
            content.append(inputField)
        }
        for (index, option) in options.enumerated() {
            let button = makeButton(option.1, action: #selector(choose(_:)))
            button.tag = index
            buttons.append(button)
        }
        let cancel = makeButton("取消", action: #selector(cancel))
        cancel.keyEquivalent = "\u{1b}"
        content.append(contentsOf: buttons)
        content.append(cancel)
        let stack = NSStackView(views: content)
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: Self.margin, left: Self.margin, bottom: Self.margin, right: Self.margin)
        panel.contentView = stack
        panel.setContentSize(NSSize(width: Self.width, height: stack.fittingSize.height))
        buttons[0].keyEquivalent = "\r"
        panel.defaultButtonCell = buttons[0].cell as? NSButtonCell
        panel.initialFirstResponder = inputField
        updateButtons()
    }

    private static func label(_ value: String, font: NSFont) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.font = font
        label.lineBreakMode = .byCharWrapping
        label.preferredMaxLayoutWidth = column
        return label
    }

    private static func textHeight(_ value: String, font: NSFont, width: CGFloat) -> CGFloat {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byCharWrapping
        let framed = NSAttributedString(string: value, attributes: [.font: font, .paragraphStyle: paragraph])
        return ceil(framed.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude),
                                        options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }

    private static func messageView(_ message: String) -> NSView {
        let font = NSFont.systemFont(ofSize: 13)
        if textHeight(message, font: font, width: column) <= 150 {
            return label(message, font: font)
        }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: column, height: 150))
        text.string = message
        text.font = font
        text.isEditable = false
        text.isHorizontallyResizable = false
        text.isVerticallyResizable = true
        text.drawsBackground = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        scroll.documentView = text
        scroll.heightAnchor.constraint(equalToConstant: 150).isActive = true
        return scroll
    }

    private func constrain(_ control: NSView) {
        control.widthAnchor.constraint(equalToConstant: Self.column).isActive = true
    }

    private func makeButton(_ title: String, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.lineBreakMode = .byCharWrapping
        button.cell?.wraps = true
        constrain(button)
        let height = Self.textHeight(title, font: button.font ?? .systemFont(ofSize: 13), width: Self.column - 24) + 12
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: max(28, height)).isActive = true
        return button
    }

    private func show(for duration: Duration, parent: pid_t?) async throws -> JSON {
        try Task.checkCancellation()
        let workspace = NSWorkspace.shared.notificationCenter
        let distributed = DistributedNotificationCenter.default()
        let lock = distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
        let inactive = workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification,
                                             object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
        let timer = Task { [weak self] in
            do {
                try await Task.sleep(for: duration)
                self?.finish(.success(DialogProcess.outcome("expired")))
            } catch {}
        }
        let owner = parent.map { pid in
            Task { [weak self] in
                while !Task.isCancelled {
                    if getppid() != pid { self?.cancel(); return }
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        defer {
            timer.cancel()
            owner?.cancel()
            workspace.removeObserver(inactive)
            distributed.removeObserver(lock)
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                completion = continuation
                guard !Task.isCancelled else { cancel(); return }
                panel.center()
                NSApplication.shared.activate()
                panel.makeKeyAndOrderFront(nil)
                panel.orderFrontRegardless()
                if !panel.isVisible { finish(.failure(AgentError("dialog_presentation_failed"))) }
            }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    func controlTextDidChange(_ notification: Foundation.Notification) { updateButtons() }

    private var inputValue: String? {
        guard let inputField else { return nil }
        let value = inputField.stringValue
        return inputField is NSSecureTextField ? value : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func updateButtons() {
        let value = inputValue ?? ""
        let valid = value.utf16.count <= 1024 && (!textRequired || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
            !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        for button in buttons { button.isEnabled = valid && authentication == nil }
    }

    @objc private func choose(_ sender: NSButton) {
        guard completion != nil, sender.isEnabled, options.indices.contains(sender.tag) else { return }
        let id = options[sender.tag].id
        if !requireAuthentication {
            finish(.success(DialogProcess.outcome("submitted", choice: id, text: inputValue)))
            return
        }
        let context = LAContext()
        context.localizedFallbackTitle = "使用密码"
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            finish(.failure(AgentError("local_authentication_unavailable")))
            return
        }
        authentication = context
        updateButtons()
        Task {
            let approved = (try? await context.evaluatePolicy(.deviceOwnerAuthentication,
                localizedReason: "确认这台 Mac 上的 FileSharingService 操作。")) == true
            guard authentication === context else { return }
            if approved {
                finish(.success(DialogProcess.outcome("submitted", choice: id, authenticated: true)))
            } else {
                cancel()
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        cancel()
        return false
    }

    @objc private func cancel() { finish(.success(DialogProcess.outcome("dismissed"))) }

    private func finish(_ result: Result<JSON, Error>) {
        guard let continuation = completion else { return }
        completion = nil
        authentication?.invalidate()
        authentication = nil
        panel.orderOut(nil)
        continuation.resume(with: result)
    }
}
#endif
