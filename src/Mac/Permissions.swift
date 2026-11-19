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
    private static let settingsPanes = ["inputMonitoring": "Privacy_ListenEvent", "pasteboard": "Privacy_Pasteboard"]
    private let roots: [LocalRoot]
    private var results = [String: Check]()
    private var systemStates = ["inputMonitoring": "requiresSystemSettings", "pasteboard": "notDetermined"]

    init(roots: [LocalRoot]) { self.roots = roots }

    func snapshot() -> JSON {
        var value = [String: JSON]()
        for id in Self.folders.keys {
            let check = results[id]
            value[id] = format(check?.state ?? "notDetermined", check, pane: "Privacy_FilesAndFolders")
        }

        for (id, pane) in Self.settingsPanes {
            value[id] = format(systemStates[id] ?? "notDetermined", results[id], pane: pane)
        }
        return .object(value)
    }

    func refresh() async -> JSON {
        for id in Self.settingsPanes.keys where results[id]?.phase != "requesting" {
            let version = results[id]?.time
            let state = await Self.check(id)
            if results[id]?.time == version { systemStates[id] = state }
        }
        return snapshot()
    }

    func request(_ id: String, changed: () -> Void) async throws -> JSON {
        guard Self.folders[id] != nil || Self.settingsPanes[id] != nil else {
            throw AgentError("unsupported")
        }
        if let last = results[id], last.phase == "requesting" || Date().timeIntervalSince(last.time) < 15 {
            throw AgentError("limit_reached")
        }
        let path = Self.folders[id].map { LocalState.home.appendingPathComponent($0, isDirectory: true).path(percentEncoded: false) }
        if let path, !roots.contains(where: { $0.isHome || $0.path == path || $0.path.hasPrefix(path + "/") }) {
            throw AgentError("permission_denied")
        }

        let previous = systemStates[id] ?? results[id]?.state ?? "notDetermined"
        results[id] = Check(state: previous, time: Date(), phase: "requesting")
        changed()
        let state = await Self.check(id, directory: path, request: true)
        results[id] = Check(state: state, time: Date(), phase: "completed")
        if path == nil { systemStates[id] = state }
        return snapshot()[id]
    }

    private func format(_ state: String, _ check: Check?, pane: String) -> JSON {
        ["state": .string(state), "phase": .string(check?.phase ?? "idle"),
         "checkedAt": check.map { .date($0.time) } ?? .null, "systemSettingsPane": .string(pane)]
    }

    nonisolated private static func check(_ id: String, directory: String? = nil, request: Bool = false) async -> String {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let state = directory.map(Self.checkDirectory) ?? Self.checkSystemPermission(id, request: request)
                continuation.resume(returning: state)
            }
        }
    }

    nonisolated private static func checkSystemPermission(_ id: String, request: Bool) -> String {
        #if FILESHARING_TEST
        if id == "pasteboard", request,
           let release = ProcessInfo.processInfo.environment["FILESHARING_TEST_PASTEBOARD_RELEASE"] {
            let deadline = ContinuousClock.now + .seconds(40)
            while !FileManager.default.fileExists(atPath: release), ContinuousClock.now < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        return "requiresSystemSettings"
        #else
        if id == "inputMonitoring" {
            return CGPreflightListenEventAccess() ? "allowed" : "requiresSystemSettings"
        }
        guard #available(macOS 15.4, *) else { return "unavailable" }
        switch NSPasteboard.general.accessBehavior {
        case .alwaysAllow: return "allowed"
        case .alwaysDeny: return "denied"
        case .ask: return "requiresSystemSettings"
        case .default: return "notDetermined"
        @unknown default: return "unknown"
        }
        #endif
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
