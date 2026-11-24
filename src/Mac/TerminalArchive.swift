import Foundation

final class TerminalArchive: @unchecked Sendable {
    private struct Manifest: Codable {
        let id: String
        let origin: URL
        let key: String
        var acknowledged = Int64(0)
        var finished = false
    }

    let directory: URL
    let id: String
    let origin: URL
    let key: String
    private let lock = NSLock()
    private var manifest: Manifest
    private var last: Int64
    private var unfinishedClose: String?

    init(directory: URL, id: String, origin: URL, key: String) throws {
        self.directory = directory
        self.id = id
        self.origin = origin
        self.key = key
        manifest = Manifest(id: id, origin: origin, key: key)
        last = 0
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try save(manifest)
    }

    init(open directory: URL) throws {
        self.directory = directory
        let data = try Data(contentsOf: directory.appendingPathComponent("manifest.json"))
        manifest = try JSONDecoder().decode(Manifest.self, from: data)
        id = manifest.id
        origin = manifest.origin
        key = manifest.key
        last = manifest.acknowledged
        guard id == directory.lastPathComponent, UUID(uuidString: id) != nil, key.utf8.count == 43,
              manifest.acknowledged >= 0 else { throw AgentError("invalid_terminal_archive") }
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            guard name.hasSuffix(".frame"), let index = Int64(name.dropLast(6)), index > 0 else { continue }
            if index <= manifest.acknowledged {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
            } else {
                last = max(last, index)
            }
        }
        if last > manifest.acknowledged {
            let frame = try JSON.decode(Data(contentsOf: url(last)))
            if ["closed", "error"].contains(frame["kind"].string ?? "") {
                manifest.finished = true
            }
        }
    }

    var finished: Bool { lock.withLock { manifest.finished } }
    var delivered: Bool { lock.withLock { manifest.finished && manifest.acknowledged == last } }

    func record(_ frame: JSON) throws {
        try lock.withLock {
            guard !manifest.finished, case .object(var fields) = frame else { return }
            let index = last + 1
            fields["index"] = .integer(index)
            fields["at"] = .integer(Int64(Date().timeIntervalSince1970))
            let data = try JSON.object(fields).encoded()
            try data.write(to: url(index), options: .atomic)
            last = index
            if ["closed", "error"].contains(frame["kind"].string ?? "") {
                manifest.finished = true
                try save(manifest)
            }
        }
    }

    func batch() throws -> [JSON] {
        try lock.withLock {
            let end = min(last, manifest.acknowledged + 32)
            guard end > manifest.acknowledged else { return [] }
            return try ((manifest.acknowledged + 1)...end).map { index in
                try JSON.decode(Data(contentsOf: url(index)))
            }
        }
    }

    func finish(_ code: String?) {
        let reason = code ?? "terminal_closed"
        do {
            try record(["kind": "closed", "code": .string(reason)])
            lock.withLock { unfinishedClose = nil }
        }
        catch { lock.withLock { unfinishedClose = reason } }
    }

    func retryFinish() {
        if let reason = lock.withLock({ unfinishedClose }) {
            finish(reason)
        }
    }

    func acknowledge(_ index: Int64) throws {
        try lock.withLock {
            guard index <= last else { throw AgentError("invalid_terminal_acknowledgment") }
            guard index > manifest.acknowledged else { return }
            let previous = manifest.acknowledged
            var updated = manifest
            updated.acknowledged = index
            try save(updated)
            manifest = updated
            for consumed in (previous + 1)...index {
                try? FileManager.default.removeItem(at: url(consumed))
            }
        }
    }

    private func save(_ value: Manifest) throws {
        try JSONEncoder().encode(value).write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    }

    private func url(_ index: Int64) -> URL { directory.appendingPathComponent("\(index).frame") }
}
