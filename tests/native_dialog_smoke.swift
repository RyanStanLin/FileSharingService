import AppKit

@main
struct NativeDialogSmoke {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task {
            let click = Task {
                try await Task.sleep(for: .milliseconds(1200))
                let visible = app.windows.filter(\.isVisible)
                guard visible.count == 1, let panel = visible.first as? NSPanel, panel.attachedSheet == nil,
                      let view = panel.contentView, panel.isOnActiveSpace, panel.frame.width == 260 else {
                    throw AgentError("native_panel_missing")
                }
                guard panel.title == "FileSharingService", panel.level == .modalPanel,
                      panel.collectionBehavior.contains(.canJoinAllApplications) else { throw AgentError("dialog_not_floating") }
                let controls = flattened(view)
                guard controls.compactMap({ $0 as? NSImageView }).first?.image === app.applicationIconImage else {
                    throw AgentError("missing_application_icon")
                }
                let fields = controls.compactMap { $0 as? NSTextField }
                guard Set(fields.filter { !$0.isEditable }.map(\.stringValue)) ==
                    ["Local smoke test", "Enter a fixture explanation."] else { throw AgentError("unexpected_dialog_copy") }
                guard let input = fields.first(where: \.isEditable), input.placeholderString == nil,
                      let button = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Submit fixture" }),
                      button.keyEquivalent == "\r", panel.defaultButtonCell === button.cell,
                      !button.isEnabled else { throw AgentError("missing_reason_validation") }
                input.stringValue = "Fixture verification"
                input.delegate?.controlTextDidChange?(.init(name: NSControl.textDidChangeNotification, object: input))
                guard button.isEnabled else { throw AgentError("cannot_submit_reason") }
                button.performClick(nil)
            }
            do {
                let request: JSON = [
                    "title": "Local smoke test",
                    "message": "Enter a fixture explanation.",
                    "choices": [["id": "submit", "label": "Submit fixture"]],
                    "askText": true,
                    "textRequired": true,
                    "timeoutSeconds": 10
                ]
                let result = try await NativeDialog.present(request)
                try await click.value
                guard result["outcome"].string == "submitted", result["choiceId"].string == "submit",
                      result["text"].string == "Fixture verification" else {
                    throw AgentError("native_response_mismatch")
                }
                guard !app.windows.contains(where: \.isVisible) else { throw AgentError("window_left_after_submission") }
                let dismiss = Task {
                    try await Task.sleep(for: .milliseconds(500))
                    guard let panel = app.windows.first(where: \.isVisible) else { throw AgentError("second_panel_missing") }
                    panel.performClose(nil)
                }
                let second = try await NativeDialog.present(request)
                try await dismiss.value
                guard second["outcome"].string == "dismissed", !app.windows.contains(where: \.isVisible) else {
                    throw AgentError("window_left_after_dismissal")
                }
                print("Single 260 pt AppKit panel displayed, submitted, and closed without a parent window.")
                exit(EXIT_SUCCESS)
            } catch {
                click.cancel()
                print("Native dialog smoke test failed: \(error)")
                exit(EXIT_FAILURE)
            }
        }
        app.run()
    }

    @MainActor
    private static func flattened(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { flattened($0) }
    }
}
