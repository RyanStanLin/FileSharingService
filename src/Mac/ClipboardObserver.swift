import AppKit
import Foundation

@MainActor
struct ClipboardObserver {
    private let pasteboard: NSPasteboard
    private var previous: Int?

    init() {
        #if FILESHARING_TEST
        let name = ProcessInfo.processInfo.environment["FILESHARING_TEST_PASTEBOARD_NAME"] ?? "FileSharing.Test.Isolated"
        pasteboard = NSPasteboard(name: .init(name))
        #else
        pasteboard = .general
        #endif
    }

    mutating func detectChange() -> (observedAt: Date, text: String?)? {
        let current = pasteboard.changeCount
        defer { previous = current }
        guard let previous, current != previous else { return nil }
        let observedAt = Date()
        #if !FILESHARING_TEST
        guard #available(macOS 15.4, *), pasteboard.accessBehavior == .alwaysAllow else {
            return (observedAt, nil)
        }
        #endif
        let text = pasteboard.string(forType: .string)
        return (observedAt, pasteboard.changeCount == current ? text : nil)
    }
}
