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

    // The ownership counter detects changes without reading the pasteboard contents.
    mutating func detectChange() -> Date? {
        let current = pasteboard.changeCount
        defer { previous = current }
        guard let previous, current != previous else { return nil }
        return Date()
    }
}
