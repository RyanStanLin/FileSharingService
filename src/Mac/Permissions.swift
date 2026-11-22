import AppKit
import CoreGraphics
import Darwin
import Foundation

@MainActor
final class DevicePermissions {
    private struct Check: Codable {
        let state: String
        let time: Date
        let phase: String
        let writable: Bool?
    }

    nonisolated static let folders = ["downloads": "Downloads", "documents": "Documents", "desktop": "Desktop"]
    private static let settingsPanes = ["inputMonitoring": "Privacy_ListenEvent", "pasteboard": "Privacy_Pasteboard"]
    private let roots: [LocalRoot]
    private let savedChecks: URL
    private var results = [String: Check]()
    private var systemStates = ["inputMonitoring": "requiresSystemSettings", "pasteboard": "notDetermined"]

    init(roots: [LocalRoot], state: LocalState) {
        self.roots = roots
        savedChecks = Self.checksURL(state)
        results = Self.loadChecks(savedChecks)
    }

    nonisolated static func allowsWriting(_ folder: String, state: LocalState) -> Bool {
        let check = loadChecks(checksURL(state))[folder]
        return check?.state == "allowed" && check?.writable == true
    }

    nonisolated private static func checksURL(_ state: LocalState) -> URL {
        state.directory.appendingPathComponent("folder-permissions.json")
    }

    nonisolated private static func loadChecks(_ url: URL) -> [String: Check] {
        guard let bytes = try? Data(contentsOf: url), bytes.count <= 4096,
              let saved = try? JSONDecoder().decode([String: Check].self, from: bytes) else { return [:] }
        return saved.filter { folders[$0.key] != nil && $0.value.phase == "completed" }
    }

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
            if results[id]?.time == version { systemStates[id] = state.state }
        }
        return snapshot()
    }

    func restorePreviouslyAllowed(_ ids: [String]) async {
        for id in Set(ids) {
            guard results[id] == nil, let path = folderPath(id), canCheckFolder(path) else { continue }
            let checked = await Self.check(id, directory: path)
            guard !Task.isCancelled else { return }
            if results[id] == nil {
                completeFolderCheck(id, state: checked.state, writable: checked.writable)
            }
        }
    }

    func request(_ id: String, changed: () -> Void) async throws -> JSON {
        guard Self.folders[id] != nil || Self.settingsPanes[id] != nil else {
            throw AgentError("unsupported")
        }
        if let last = results[id], last.phase == "requesting" || Date().timeIntervalSince(last.time) < 15 {
            throw AgentError("limit_reached")
        }
        let path = folderPath(id)
        if let path, !canCheckFolder(path) {
            throw AgentError("permission_denied")
        }

        let previous = systemStates[id] ?? results[id]?.state ?? "notDetermined"
        results[id] = Check(state: previous, time: Date(), phase: "requesting", writable: results[id]?.writable)
        changed()
        let checked = await Self.check(id, directory: path, request: true)
        if path != nil {
            completeFolderCheck(id, state: checked.state, writable: checked.writable)
        } else {
            results[id] = Check(state: checked.state, time: Date(), phase: "completed", writable: nil)
            systemStates[id] = checked.state
        }
        return snapshot()[id]
    }

    private func folderPath(_ id: String) -> String? {
        Self.folders[id].map { LocalState.home.appendingPathComponent($0, isDirectory: true).path(percentEncoded: false) }
    }

    private func canCheckFolder(_ path: String) -> Bool {
        roots.contains { $0.isHome || $0.path == path || $0.path.hasPrefix(path + "/") }
    }

    private func completeFolderCheck(_ id: String, state: String, writable: Bool?) {
        results[id] = Check(state: state, time: Date(), phase: "completed", writable: writable)
        let saved = results.filter { Self.folders[$0.key] != nil && $0.value.phase == "completed" }
        do {
            try JSONEncoder().encode(saved).write(to: savedChecks, options: .atomic)
        } catch {
            results[id] = Check(state: state, time: Date(), phase: "completed", writable: false)
        }
    }

    private func format(_ state: String, _ check: Check?, pane: String) -> JSON {
        var result: [String: JSON] = ["state": .string(state), "phase": .string(check?.phase ?? "idle"),
            "checkedAt": check.map { .date($0.time) } ?? .null, "systemSettingsPane": .string(pane)]
        if let writable = check?.writable { result["writable"] = .boolean(writable) }
        return .object(result)
    }

    nonisolated private static func check(_ id: String, directory: String? = nil, request: Bool = false) async -> (state: String, writable: Bool?) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let state = directory.map(Self.checkDirectory) ?? (Self.checkSystemPermission(id, request: request), nil)
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

    nonisolated private static func checkDirectory(_ path: String) -> (state: String, writable: Bool?) {
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            return (errno == EACCES || errno == EPERM ? "denied" : "unavailable", false)
        }
        guard let directory = fdopendir(fd) else {
            close(fd)
            return ("unavailable", false)
        }
        defer { closedir(directory) }
        errno = 0
        if readdir(directory) == nil && errno != 0 {
            return (errno == EACCES || errno == EPERM ? "denied" : "unavailable", false)
        }
        return ("allowed", faccessat(fd, ".", W_OK | X_OK, AT_EACCESS) == 0)
    }
}
