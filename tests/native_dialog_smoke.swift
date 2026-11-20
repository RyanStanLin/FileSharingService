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
                guard let parent = app.windows.first(where: { $0.attachedSheet != nil }), let sheet = parent.attachedSheet,
                      let view = sheet.contentView, sheet.isVisible, sheet.isOnActiveSpace else {
                    throw AgentError("native_sheet_missing")
                }
                guard parent.title == "FileSharingService", parent.level == .modalPanel, sheet.level == parent.level,
                      parent.collectionBehavior.contains(.canJoinAllApplications) else { throw AgentError("dialog_not_floating") }
                let controls = flattened(view)
                let fields = controls.compactMap { $0 as? NSTextField }
                guard Set(fields.filter { !$0.isEditable }.map(\.stringValue)) ==
                    ["Local smoke test", "Enter a fixture explanation."] else { throw AgentError("unexpected_dialog_copy") }
                guard let input = fields.first(where: \.isEditable), input.placeholderString == nil,
                      let button = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Submit fixture" }),
                      button.keyEquivalent == "\r", !button.isEnabled else { throw AgentError("missing_reason_validation") }
                input.stringValue = "Fixture verification"
                input.delegate?.controlTextDidChange?(.init(name: NSControl.textDidChangeNotification, object: input))
                guard button.isEnabled else { throw AgentError("cannot_submit_reason") }
                button.performClick(nil)
            }
            do {
                let request: JSON = [
                    "title": "Local smoke test",
                    "message": "Enter a fixture explanation.",
                    "icon": "warning",
                    "choices": [["id": "submit", "label": "Submit fixture"]],
                    "askText": true,
                    "textRequired": true,
                    "timeoutSeconds": 10
                ]
                let result = try await DeviceInteractions().present(request)
                try await click.value
                guard result["outcome"].string == "submitted", result["choiceId"].string == "submit",
                      result["text"].string == "Fixture verification" else {
                    throw AgentError("native_response_mismatch")
                }
                print("Native AppKit sheet displayed and returned its selection and text.")
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
