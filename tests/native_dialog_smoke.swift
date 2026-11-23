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
                try await submitsConfiguredTextFields()
                try await submitsOnlyVisibleChoice()
                try await dismissesWithEscapeWhileEditing()
                try await expiresAndReopens()
                try await dismissesOnTaskCancellation()
                print("Native NSAlert smoke passed: configured fields, screen centering, buttons, Escape, timeout, and reopening.")
                exit(EXIT_SUCCESS)
            } catch {
                fail(error)
            }
        }
        app.run()
    }

    private static func request(message: String, askText: Bool = true, maskText: Bool = false, singleChoice: Bool = false) -> JSON {
        var choices: [JSON] = [["id": "submit", "label": "同意"]]
        if !singleChoice { choices.append(["id": "review", "label": "暂缓"]) }
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
            guard buttons.count == 1, let primary = buttons.first, primary.title == "同意",
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
            let buttons = controls.compactMap { $0 as? NSButton }.filter { !$0.isHiddenOrHasHiddenAncestor }
            guard let field = fields.first(where: \.isEditable), !(field is NSSecureTextField), field.placeholderString == nil,
                  let editor = field.currentEditor() as? NSTextView,
                  buttons.count == 2,
                  let primary = buttons.first(where: { $0.title == "同意" }),
                  let review = buttons.first(where: { $0.title == "暂缓" }),
                  window.defaultButtonCell === primary.cell,
                  !primary.isEnabled, !review.isEnabled else { throw AgentError("invalid_plain_input_or_default_button") }
            let primaryFrame = primary.convert(primary.bounds, to: nil)
            let reviewFrame = review.convert(review.bounds, to: nil)
            guard abs(primaryFrame.midY - reviewFrame.midY) <= 1, primaryFrame.minX >= reviewFrame.maxX else {
                throw AgentError("expected_two_horizontal_choices_with_primary_on_right")
            }
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
                  let primary = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "同意" }),
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
    private static func submitsConfiguredTextFields() async throws {
        let preset = "  Approved maintenance  "
        let code = "  00-APP-42  "
        let options = request(message: "请填写确认信息。", askText: false)
        guard case .object(var form) = options else { throw AgentError("invalid_fixture") }
        form["textFields"] = [
            ["id": "reference", "hintText": "工单编号", "defaultText": "CHG-42", "disabled": true, "required": true],
            ["id": "reason", "hintText": "原因", "defaultText": .string(preset), "required": true],
            ["id": "approval", "hintText": "审批码", "maskText": true, "required": true],
            ["id": "note", "hintText": "备注"]
        ]
        let result = try await interact(with: .object(form)) { window, controls in
            let fields = controls.compactMap { $0 as? NSTextField }.filter { $0.placeholderString != nil }
            guard abs(window.frame.width - 260) <= 1,
                  fields.map(\.placeholderString) == ["工单编号", "原因", "审批码", "备注"] else {
                throw AgentError("unexpected_configured_fields")
            }
            let reference = fields[0], reason = fields[1], approval = fields[2], note = fields[3]
            guard reference.stringValue == "CHG-42", !reference.isEnabled, !reference.isEditable,
                  reason.stringValue == preset, reason.isEnabled, reason.currentEditor() != nil,
                  approval is NSSecureTextField, (approval.cell as? NSSecureTextFieldCell)?.echosBullets == true,
                  note.stringValue.isEmpty,
                  let primary = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "同意" }),
                  !primary.isEnabled, window.makeFirstResponder(approval),
                  let editor = approval.currentEditor() as? NSTextView else {
                throw AgentError("incorrect_field_configuration")
            }
            editor.insertText("  ", replacementRange: NSRange(location: NSNotFound, length: 0))
            guard !primary.isEnabled else { throw AgentError("blank_required_field_accepted") }
            editor.selectAll(nil)
            editor.insertText(code, replacementRange: NSRange(location: NSNotFound, length: 0))
            guard primary.isEnabled else { throw AgentError("filled_fields_cannot_submit") }
            primary.performClick(nil)
        }
        guard result["outcome"].string == "submitted", result["choiceId"].string == "submit", result["text"] == .null,
              result["textValues"] == ["reason": .string(preset), "approval": .string(code), "note": ""] else {
            throw AgentError("configured_field_response_mismatch")
        }
    }

    @MainActor
    private static func dismissesWithEscapeWhileEditing() async throws {
        for singleChoice in [true, false] {
            let input = request(message: "Dismiss this fixture with Escape.", maskText: true, singleChoice: singleChoice)
            let result = try await interact(with: input) { window, _ in
                try postKey("\u{1b}", code: 53, to: window)
            }
            guard result["outcome"].string == "dismissed", result["choiceId"] == .null, result["text"] == .null else {
                throw AgentError("escape_did_not_dismiss")
            }
        }
    }

    @MainActor
    private static func expiresAndReopens() async throws {
        let start = ContinuousClock.now
        let result = try await interact(with: request(message: "This fixture expires after 10 seconds.", askText: false)) { _, _ in }
        guard result["outcome"].string == "expired", result["choiceId"] == .null, result["text"] == .null,
              start.duration(to: .now) < .seconds(13) else { throw AgentError("native_modal_did_not_expire") }
        try await submitsOnlyVisibleChoice()
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
