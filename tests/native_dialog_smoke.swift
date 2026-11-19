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
                guard let sheet = app.windows.compactMap(\.attachedSheet).first, let view = sheet.contentView else {
                    throw AgentError("native_sheet_missing")
                }
                let controls = flattened(view)
                guard let input = controls.compactMap({ $0 as? NSTextField }).first(where: \.isEditable),
                      let button = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "Submit fixture" }),
                      !button.isEnabled else { throw AgentError("missing_reason_validation") }
                input.stringValue = "Fixture verification"
                input.delegate?.controlTextDidChange?(.init(name: NSControl.textDidChangeNotification, object: input))
                guard button.isEnabled else { throw AgentError("cannot_submit_reason") }
                button.performClick(nil)
            }
            do {
                let request: JSON = [
                    "title": "Local smoke test",
                    "message": "This test window will close automatically.",
                    "icon": "warning",
                    "choices": [["id": "submit", "label": "Submit fixture"]],
                    "askText": true,
                    "textRequired": true,
                    "timeoutSeconds": 10
                ]
                let origin = URL(string: "http://localhost:8847")!
                let result = try await DeviceInteractions().present(request, from: origin)
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
