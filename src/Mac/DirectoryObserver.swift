import CoreServices
import Foundation

private final class StreamSignal {
    let action: @Sendable (Bool) -> Void
    init(action: @escaping @Sendable (Bool) -> Void) { self.action = action }
}

final class NativeDirectoryStream: @unchecked Sendable {
    private let signal: StreamSignal
    private let stream: FSEventStreamRef

    init?(path: String, action: @escaping @Sendable (Bool) -> Void) {
        let signal = StreamSignal(action: action)
        var context = FSEventStreamContext()
        context.info = Unmanaged.passUnretained(signal).toOpaque()
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot)
        guard let stream = FSEventStreamCreate(nil, { _, pointer, count, _, flags, _ in
            guard let pointer else { return }
            let dropped = UnsafeBufferPointer(start: flags, count: count).contains {
                $0 & FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged) != 0
            }
            Unmanaged<StreamSignal>.fromOpaque(pointer).takeUnretainedValue().action(dropped)
        }, &context, [path] as CFArray, UInt64(kFSEventStreamEventIdSinceNow), 0.16, flags) else { return nil }
        FSEventStreamSetDispatchQueue(stream, .main)
        if !FSEventStreamStart(stream) {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            return nil
        }
        self.signal = signal
        self.stream = stream
    }

    deinit {
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}

@MainActor
final class DirectoryObserver {
    private final class Entry {
        let root: String
        let path: String
        let stream: NativeDirectoryStream
        var expires: Date
        var revision: String
        var items: [String: FileItem]?
        var resync = false
        var dirty = false
        var scheduled = false

        init(root: String, path: String, stream: NativeDirectoryStream, content: DirectoryContents, expires: Date) {
            self.root = root
            self.path = path
            self.stream = stream
            self.expires = expires
            revision = content.revision
            items = Self.smallMap(content)
        }

        static func smallMap(_ content: DirectoryContents) -> [String: FileItem]? {
            content.entries.count > 2_048 ? nil : Dictionary(uniqueKeysWithValues: content.entries.map { ($0.name, $0) })
        }
    }

    private let files: ScopedFiles
    private let emit: (JSON) -> Void
    private var entries = [String: Entry]()

    init(files: ScopedFiles, emit: @escaping (JSON) -> Void) {
        self.files = files
        self.emit = emit
    }

    func start(_ value: JSON) async throws -> JSON {
        let id = try value.requireString("watchId")
        let path = try value.requireString("path")
        let root = try value.requireString("root")
        let seconds = try value.requireInt("seconds")
        guard UUID(uuidString: id) != nil, (10...60).contains(seconds) else { throw AgentError("invalid_request") }
        let lease = Date().addingTimeInterval(Double(seconds))
        if let existing = entries[id] {
            guard existing.path == path, existing.root == root else { throw AgentError("invalid_request") }
            existing.expires = lease
            return ["revision": .string(existing.revision)]
        }
        prune()
        guard entries.count < 4 else { throw AgentError("limit_reached") }
        let (allowed, content) = try await files.watchTarget(rootKey: root, path: path)
        let absolute = path.isEmpty ? allowed.path : allowed.path + "/" + path
        guard let stream = NativeDirectoryStream(path: absolute, action: { [weak self] resync in
            Task { @MainActor in self?.mark(id, resync: resync) }
        }) else { throw AgentError("unsupported") }
        entries[id] = Entry(root: root, path: path, stream: stream, content: content, expires: lease)
        mark(id, resync: false)
        emit(["watchId": .string(id), "kind": "resync_required", "revision": .string(content.revision)])
        return ["revision": .string(content.revision)]
    }

    func stop(_ value: JSON) throws -> JSON {
        entries.removeValue(forKey: try value.requireString("watchId"))
        return [:]
    }

    func prune() { entries = entries.filter { $0.value.expires > Date() } }
    func reset() { entries.removeAll() }

    private func mark(_ id: String, resync: Bool) {
        guard let entry = entries[id] else { return }
        entry.resync = entry.resync || resync
        entry.dirty = true
        guard !entry.scheduled else { return }
        entry.scheduled = true
        Task {
            try? await Task.sleep(for: .milliseconds(120))
            while let current = entries[id], current === entry, entry.dirty {
                entry.dirty = false
                await update(id, entry)
            }
            entry.scheduled = false
        }
    }

    private func update(_ id: String, _ entry: Entry) async {
        do {
            let (_, snapshot) = try await files.watchTarget(rootKey: entry.root, path: entry.path)
            guard entries[id] === entry else { return }
            let invalidated = entry.resync
            entry.resync = false
            if !invalidated && snapshot.revision == entry.revision { return }
            let next = Entry.smallMap(snapshot)
            let previous = entry.revision
            entry.revision = snapshot.revision
            defer { entry.items = next }
            if invalidated || entry.items == nil || next == nil {
                emit(["watchId": .string(id), "kind": "resync_required", "revision": .string(snapshot.revision)])
                return
            }
            let before = entry.items!
            let after = next!
            let removed = before.values.filter { after[$0.name] == nil }
            let added = after.values.filter { before[$0.name] == nil }
            let newIdentities = Dictionary(grouping: added, by: \.identity)
            var matched = Set<String>()
            var changes = [JSON]()
            for item in removed.sorted(by: { $0.name < $1.name }) {
                if item.kind == "directory" || item.info.st_nlink == 1,
                   let candidates = newIdentities[item.identity], candidates.count == 1, let renamed = candidates.first,
                   matched.insert(renamed.name).inserted {
                    changes.append(["kind": "renamed", "fromPath": .string(item.relative), "entry": renamed.value])
                } else {
                    changes.append(["kind": "removed", "entry": item.value])
                }
                if changes.count > 100 {
                    emit(["watchId": .string(id), "kind": "resync_required", "revision": .string(snapshot.revision)])
                    return
                }
            }
            for name in after.keys.sorted() where !matched.contains(name) && before[name]?.version != after[name]?.version {
                let item = after[name]!
                changes.append(["kind": before[name] == nil ? "added" : "updated", "entry": item.value])
                if changes.count > 100 {
                    emit(["watchId": .string(id), "kind": "resync_required", "revision": .string(snapshot.revision)])
                    return
                }
            }
            emit(["watchId": .string(id), "kind": "delta", "previousRevision": .string(previous),
                  "revision": .string(snapshot.revision), "changes": .array(changes)])
        } catch {
            if entries[id] === entry {
                emit(["watchId": .string(id), "kind": "resync_required", "revision": .null])
            }
        }
    }
}
