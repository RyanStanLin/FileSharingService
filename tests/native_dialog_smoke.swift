import AppKit

@main
struct NativeDialogSmoke {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task {
            do {
                try await submitsPlainTextAndSelectedOption()
                try await submitsMaskedApprovalCode()
                try await submitsOnlyVisibleChoice()
                try await dismissesWithCancelButton()
                try await dismissesWithEscapeWhileEditing()
                try await expiresAndReopens()
                try await dismissesOnTaskCancellation()
                print("Native NSAlert smoke passed: screen centering, one-button layout, input, cancellation, timeout, and reopening.")
                exit(EXIT_SUCCESS)
            } catch {
                fail(error)
            }
        }
        app.run()
    }

    private static func request(message: String, askText: Bool = true, maskText: Bool = false, singleChoice: Bool = false) -> JSON {
        var choices: [JSON] = [["id": "submit", "label": "Submit fixture"]]
        if !singleChoice { choices.append(["id": "review", "label": "Review fixture"]) }
        return ["title": "Local smoke test",
         "message": .string(message),
         "choices": .array(choices),
         "askText": .boolean(askText), "textRequired": .boolean(askText), "maskText": .boolean(maskText), "timeoutSeconds": 10]
    }

    @MainActor
    private static func submitsOnlyVisibleChoice() async throws {
        let input = request(message: "Confirm this fixture.", askText: false, singleChoice: true)
        let result = try await interact(with: input) { window, controls in
            let buttons = controls.compactMap { $0 as? NSButton }.filter { !$0.isHiddenOrHasHiddenAncestor }
            guard buttons.count == 1, let primary = buttons.first, primary.title == "Submit fixture",
                  window.defaultButtonCell === primary.cell else { throw AgentError("expected_one_visible_default_button") }
            primary.performClick(nil)
        }
        guard result["outcome"].string == "submitted", result["choiceId"].string == "submit", result["text"] == .null else {
            throw AgentError("single_option_response_mismatch")
        }
    }

    @MainActor
    private static func submitsPlainTextAndSelectedOption() async throws {
        let message = "Enter a fixture explanation."
        let result = try await interact(with: request(message: message)) { window, controls in
            let app = NSApplication.shared
            guard window.level == .modalPanel, window.isOnActiveSpace, window.isKeyWindow,
                  window.collectionBehavior.contains(.canJoinAllApplications) else { throw AgentError("alert_not_floating") }
            guard controls.compactMap({ $0 as? NSImageView }).contains(where: { $0.image === app.applicationIconImage }) else {
                throw AgentError("missing_application_icon")
            }
            let fields = controls.compactMap { $0 as? NSTextField }
            let labels = Set(fields.filter { !$0.isEditable }.map(\.stringValue))
            guard labels == ["Local smoke test", message] else { throw AgentError("unexpected_dialog_copy") }
            let buttons = controls.compactMap { $0 as? NSButton }
            guard let field = fields.first(where: \.isEditable), !(field is NSSecureTextField), field.placeholderString == nil,
                  let editor = field.currentEditor() as? NSTextView,
                  let primary = buttons.first(where: { $0.title == "Submit fixture" }),
                  let review = buttons.first(where: { $0.title == "Review fixture" }),
                  window.defaultButtonCell === primary.cell,
                  !primary.isEnabled, !review.isEnabled else { throw AgentError("invalid_plain_input_or_default_button") }
            editor.insertText("Fixture verification", replacementRange: NSRange(location: NSNotFound, length: 0))
            guard primary.isEnabled, review.isEnabled else { throw AgentError("cannot_submit_reason") }
            print("Stock NSAlert frame with a short title, message, and input: \(Int(window.frame.width)) pt.")
            review.performClick(nil)
        }
        guard result["outcome"].string == "submitted", result["choiceId"].string == "review",
              result["text"].string == "Fixture verification" else { throw AgentError("plain_response_mismatch") }
    }

    @MainActor
    private static func submitsMaskedApprovalCode() async throws {
        let approval = "  00-APP-42  "
        let result = try await interact(with: request(message: "Enter the fixture approval code.", maskText: true)) { window, controls in
            guard let field = controls.compactMap({ $0 as? NSSecureTextField }).first,
                  field.placeholderString == nil, (field.cell as? NSSecureTextFieldCell)?.echosBullets == true,
                  let editor = field.currentEditor() as? NSTextView,
                  let primary = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Submit fixture" }),
                  !primary.isEnabled else { throw AgentError("approval_control_not_masked") }
            editor.insertText(approval, replacementRange: NSRange(location: NSNotFound, length: 0))
            guard primary.isEnabled else { throw AgentError("cannot_submit_approval") }
            try postKey("\r", code: 36, to: window)
        }
        guard result["outcome"].string == "submitted", result["choiceId"].string == "submit",
              result["text"].string == approval, result["locallyAuthenticated"] == .null else {
            throw AgentError("approval_response_mismatch")
        }
    }

    @MainActor
    private static func dismissesWithEscapeWhileEditing() async throws {
        let input = request(message: "Dismiss this fixture with Escape.", maskText: true, singleChoice: true)
        let result = try await interact(with: input) { window, _ in
            try postKey("\u{1b}", code: 53, to: window)
        }
        guard result["outcome"].string == "dismissed", result["text"] == .null else { throw AgentError("escape_did_not_dismiss") }
    }

    @MainActor
    private static func dismissesWithCancelButton() async throws {
        let result = try await interact(with: request(message: "Dismiss this fixture.", askText: false)) { _, controls in
            guard !controls.compactMap({ $0 as? NSTextField }).contains(where: \.isEditable),
                  let cancel = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "取消" }),
                  cancel.isEnabled, cancel.keyEquivalent == "\u{1b}" else { throw AgentError("missing_cancel_button") }
            cancel.performClick(nil)
        }
        guard result["outcome"].string == "dismissed", result["text"] == .null else { throw AgentError("cancel_response_mismatch") }
    }

    @MainActor
    private static func expiresAndReopens() async throws {
        let start = ContinuousClock.now
        let result = try await interact(with: request(message: "This fixture expires after 10 seconds.", askText: false)) { _, _ in }
        guard result["outcome"].string == "expired", result["choiceId"] == .null, result["text"] == .null,
              start.duration(to: .now) < .seconds(13) else { throw AgentError("native_modal_did_not_expire") }
        try await dismissesWithCancelButton()
    }

    @MainActor
    private static func dismissesOnTaskCancellation() async throws {
        let task = Task { try await NativeDialog.present(request(message: "Cancel this fixture from the caller.")) }
        let cancel = Timer(timeInterval: 0.5, repeats: false) { _ in task.cancel() }
        RunLoop.main.add(cancel, forMode: .modalPanel)
        defer { cancel.invalidate() }
        let result = try await task.value
        guard result["outcome"].string == "dismissed", !NSApplication.shared.windows.contains(where: \.isVisible) else {
            throw AgentError("native_modal_did_not_cancel")
        }
    }

    @MainActor
    private static func interact(with input: JSON, _ action: @escaping @MainActor (NSWindow, [NSView]) throws -> Void) async throws -> JSON {
        let app = NSApplication.shared
        let click = Timer(timeInterval: 0.5, repeats: false) { _ in
            MainActor.assumeIsolated {
                do {
                    let visible = app.windows.filter(\.isVisible)
                    guard visible.count == 1, let window = app.modalWindow, window === visible.first,
                          window.sheetParent == nil, window.attachedSheet == nil, let content = window.contentView else {
                        throw AgentError("expected_one_standalone_modal_alert")
                    }
                    guard let screen = window.screen else { throw AgentError("native_alert_has_no_screen") }
                    let offsetX = window.frame.midX - screen.frame.midX
                    let offsetY = window.frame.midY - screen.frame.midY
                    guard abs(offsetX) <= 1, abs(offsetY) <= 1 else {
                        print("Alert center offset in points: (\(offsetX), \(offsetY)).")
                        throw AgentError("native_alert_not_centered")
                    }
                    try action(window, flattened(content))
                } catch {
                    fail(error)
                }
            }
        }
        RunLoop.main.add(click, forMode: .modalPanel)
        defer { click.invalidate() }
        let result = try await NativeDialog.present(input)
        guard !app.windows.contains(where: \.isVisible) else { throw AgentError("window_left_after_response") }
        return result
    }

    @MainActor
    private static func flattened(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { flattened($0) }
    }

    @MainActor
    private static func postKey(_ characters: String, code: UInt16, to window: NSWindow) throws {
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                          context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                          isARepeat: false, keyCode: code) else { throw AgentError("missing_key_event") }
        NSApplication.shared.postEvent(event, atStart: true)
    }

    private static func fail(_ error: Error) -> Never {
        print("Native dialog smoke test failed: \(error)")
        exit(EXIT_FAILURE)
    }
}
