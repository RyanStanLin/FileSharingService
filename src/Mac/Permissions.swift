import AppKit
import CoreGraphics
import Darwin
import Foundation

@MainActor
final class DevicePermissions {
    private struct Check {
        let state: String
        let time: Date
        let phase: String
    }

    private static let folders = ["downloads": "Downloads", "documents": "Documents", "desktop": "Desktop"]
    private let roots: [LocalRoot]
    private var results = [String: Check]()

    init(roots: [LocalRoot]) { self.roots = roots }

    func snapshot() -> JSON {
        var value = [String: JSON]()
        for id in Self.folders.keys {
            let check = results[id]
            value[id] = format(check?.state ?? "notDetermined", check, pane: "Privacy_FilesAndFolders")
        }

        #if FILESHARING_TEST
        let input = "requiresSystemSettings"
        let pasteboard = "requiresSystemSettings"
        #else
        let input = CGPreflightListenEventAccess() ? "allowed" : "requiresSystemSettings"
        let pasteboard: String
        if #available(macOS 15.4, *) {
            switch NSPasteboard.general.accessBehavior {
            case .alwaysAllow: pasteboard = "allowed"
            case .alwaysDeny: pasteboard = "denied"
            case .ask, .default: pasteboard = "requiresSystemSettings"
            @unknown default: pasteboard = "unknown"
            }
        } else {
            pasteboard = "unavailable"
        }
        #endif
        value["inputMonitoring"] = format(input, results["inputMonitoring"], pane: "Privacy_ListenEvent")
        value["pasteboard"] = format(pasteboard, results["pasteboard"], pane: "Privacy_Pasteboard")
        return .object(value)
    }

    func request(_ id: String, changed: () -> Void) async throws -> JSON {
        guard Self.folders[id] != nil || ["inputMonitoring", "pasteboard"].contains(id) else {
            throw AgentError("unsupported")
        }
        if let last = results[id], last.phase == "requesting" || Date().timeIntervalSince(last.time) < 15 {
            throw AgentError("limit_reached")
        }
        guard let folder = Self.folders[id] else {
            results[id] = Check(state: "requiresSystemSettings", time: Date(), phase: "completed")
            return snapshot()[id]
        }

        let path = LocalState.home.appendingPathComponent(folder, isDirectory: true).path(percentEncoded: false)
        guard roots.contains(where: { $0.isHome || $0.path == path || $0.path.hasPrefix(path + "/") })
        else { throw AgentError("permission_denied") }
        results[id] = Check(state: results[id]?.state ?? "notDetermined", time: Date(), phase: "requesting")
        changed()
        let state = await Task.detached(priority: .utility) {
            Self.checkDirectory(path)
        }.value
        results[id] = Check(state: state, time: Date(), phase: "completed")
        return snapshot()[id]
    }

    private func format(_ state: String, _ check: Check?, pane: String) -> JSON {
        ["state": .string(state), "phase": .string(check?.phase ?? "idle"),
         "checkedAt": check.map { .date($0.time) } ?? .null, "systemSettingsPane": .string(pane)]
    }

    nonisolated private static func checkDirectory(_ path: String) -> String {
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            return errno == EACCES || errno == EPERM ? "denied" : "unavailable"
        }
        guard let directory = fdopendir(fd) else {
            close(fd)
            return "unavailable"
        }
        defer { closedir(directory) }
        errno = 0
        if readdir(directory) == nil && errno != 0 {
            return errno == EACCES || errno == EPERM ? "denied" : "unavailable"
        }
        return "allowed"
    }
}
