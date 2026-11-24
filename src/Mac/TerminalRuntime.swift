import Foundation
import os
import OSLog

actor TerminalRuntime {
    private struct Entry {
        let archive: TerminalArchive
        let process: TerminalProcess?
        var lastCommand: String?
        var stopping = false
        var orphaned = false
    }

    private struct Link: Sendable {
        let origin: URL
        let id: String
    }

    private let directory: URL
    private let origins: [URL]
    private let link = OSAllocatedUnfairLock<Link?>(initialState: nil)
    private let logger = Logger(subsystem: "in.ryanl.filesharing.agent", category: "Terminal")
    private var entries: [String: Entry] = [:]
    private var restored = false

    init(state: LocalState, origins: [URL]) {
        directory = state.directory.appendingPathComponent("terminals", isDirectory: true)
        self.origins = origins
    }

    nonisolated func connected(_ origin: URL, _ id: String?) {
        link.withLock { $0 = id.map { Link(origin: origin, id: $0) } }
    }

    nonisolated func disconnected() { link.withLock { $0 = nil } }

    func create(id: String, root: String, key: String, origin: URL) throws {
        try restore()
        guard UUID(uuidString: id) != nil, key.utf8.count == 43, origins.contains(origin) else {
            throw AgentError("invalid_request")
        }
        if let existing = entries[id] {
            guard existing.archive.key == key, existing.archive.origin == origin else { throw AgentError("invalid_request") }
            return
        }
        guard !entries.values.contains(where: { !$0.archive.finished && $0.process != nil }) else {
            throw AgentError("terminal_busy")
        }
        let folder = directory.appendingPathComponent(id, isDirectory: true)
        let archive = try TerminalArchive(directory: folder, id: id, origin: origin, key: key)
        do {
            let process = try TerminalProcess(root: root, archive: archive)
            entries[id] = Entry(archive: archive, process: process)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }

    func input(id: String, value: JSON) throws {
        guard let entry = entries[id], let process = entry.process, !entry.stopping, !entry.archive.finished else {
            throw AgentError("terminal_closed")
        }
        try process.send(value)
    }

    func control(id: String, value: JSON) async throws {
        guard let entry = entries[id], let process = entry.process, !entry.stopping, !entry.archive.finished else {
            throw AgentError("terminal_closed")
        }
        try await process.control(value)
    }

    func run() async {
        do { try restore() }
        catch { logger.error("Terminal archive could not be loaded.") }
        let httpSession = AgentHttp.createSession()
        defer { httpSession.invalidateAndCancel() }
        while !Task.isCancelled {
            var pending = false
            for id in Array(entries.keys) where !Task.isCancelled {
                if let entry = entries[id], !entry.orphaned {
                    pending = await synchronize(entry.archive, in: httpSession) || pending
                }
            }
            try? await Task.sleep(for: pending ? .milliseconds(50) : .milliseconds(entries.isEmpty ? 500 : 220))
        }
    }

    private func restore() throws {
        guard !restored else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        for folder in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            guard UUID(uuidString: folder.lastPathComponent) != nil else { continue }
            do {
                let archive = try TerminalArchive(open: folder)
                guard origins.contains(archive.origin) else { continue }
                if !archive.finished {
                    try archive.record(["kind": "closed", "code": "terminal_agent_restarted"])
                }
                entries[archive.id] = Entry(archive: archive, process: nil)
            } catch {
                logger.error("A terminal archive could not be restored.")
            }
        }
        restored = true
    }

    private func synchronize(_ archive: TerminalArchive, in session: URLSession) async -> Bool {
        let id = archive.id
        do {
            let frames = try archive.batch()
            let connection = link.withLock { $0?.origin == archive.origin ? $0?.id : nil }
            let response = try await AgentHttp(session: session, base: archive.origin).call(
                "terminals/\(id)/sync", body: ["connectionId": .text(connection), "frames": .array(frames)], terminal: archive.key)
            if response["deleted"].bool == true {
                stop(id)
                archive.retryFinish()
                if archive.finished {
                    try remove(archive)
                }
                return false
            }
            let acknowledged = try response.requireInt("acknowledged")
            try archive.acknowledge(acknowledged)
            archive.retryFinish()
            if response["terminate"].bool == true {
                stop(id)
            } else if let commandId = response["command"]["commandId"].string, var entry = entries[id],
                      entry.lastCommand != commandId, !entry.stopping, !archive.finished, let process = entry.process {
                entry.lastCommand = commandId
                entries[id] = entry
                do {
                    try process.send(response["command"])
                } catch {
                    try archive.record(["kind": "exit", "commandId": .string(commandId), "exitCode": 1,
                                        "code": .string((error as? AgentError)?.code ?? "diagnostic_start_failed")])
                }
            }
            if archive.delivered {
                try remove(archive)
            }
            return frames.count == 32
        } catch let error as AgentError where error.code == "terminal_not_found" {
            stop(id)
            entries[id]?.orphaned = true
            logger.error("The server no longer recognizes a terminal archive. Local records were retained.")
        } catch {
            // Transport failures leave the PTY and the local journal available to a later attempt.
        }
        return false
    }

    private func remove(_ archive: TerminalArchive) throws {
        try FileManager.default.removeItem(at: archive.directory)
        entries.removeValue(forKey: archive.id)
    }

    private func stop(_ id: String) {
        guard var entry = entries[id], !entry.stopping, let process = entry.process, !entry.archive.finished else { return }
        entry.stopping = true
        entries[id] = entry
        process.close()
    }
}
