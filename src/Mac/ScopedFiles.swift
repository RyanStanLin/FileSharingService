import CryptoKit
import Darwin
import Foundation

final class Descriptor {
    private struct VolumeAttributes {
        var length: UInt32 = 0
        var uuid: uuid_t = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    }

    let fd: Int32
    init(_ fd: Int32) throws {
        guard fd >= 0 else { throw ScopedFiles.failure() }
        self.fd = fd
    }

    deinit { close(fd) }

    func info() throws -> stat {
        var data = stat()
        guard fstat(fd, &data) == 0 else { throw ScopedFiles.failure() }
        return data
    }

    var volumeUUID: UUID? {
        var request = attrlist()
        request.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
        request.volattr = UInt32(ATTR_VOL_INFO) | UInt32(ATTR_VOL_UUID)
        var attributes = VolumeAttributes()
        let result = withUnsafeMutableBytes(of: &attributes) {
            fgetattrlist(fd, &request, $0.baseAddress!, $0.count, 0)
        }
        guard result == 0, attributes.length == MemoryLayout<VolumeAttributes>.size,
              withUnsafeBytes(of: attributes.uuid, { $0.contains(where: { $0 != 0 }) }) else { return nil }
        return UUID(uuid: attributes.uuid)
    }
}

struct FileItem {
    let name: String
    let relative: String
    let root: LocalRoot
    let info: stat

    var kind: String {
        switch info.st_mode & S_IFMT {
        case S_IFREG: return "file"
        case S_IFDIR: return "directory"
        case S_IFLNK: return "symlink"
        default: return "other"
        }
    }

    var hidden: Bool {
        if root.isHome && relative.caseInsensitiveCompare("Library") == .orderedSame { return false }
        return name.hasPrefix(".") || info.st_flags & UInt32(UF_HIDDEN) != 0
    }
    var version: String {
        let fields = [String(info.st_dev), String(info.st_ino), String(info.st_mode), String(info.st_uid),
                      String(info.st_size), String(info.st_mtimespec.tv_sec), String(info.st_mtimespec.tv_nsec),
                      String(info.st_ctimespec.tv_sec), String(info.st_ctimespec.tv_nsec)]
        return Data(SHA256.hash(data: Data(fields.joined(separator: ":").utf8))).base64URL
    }

    var identity: String { "\(info.st_dev):\(info.st_ino)" }

    var value: JSON {
        ["name": .string(name), "path": .string(relative), "fullPath": .string(relative.isEmpty ? root.path : root.path + "/" + relative),
         "kind": .string(kind), "size": .integer(kind == "file" ? info.st_size : 0), "owner": .integer(Int64(info.st_uid)),
         "mode": .integer(Int64(info.st_mode & 0o7777)), "version": .string(version), "hidden": .boolean(hidden),
         "createdAt": created.map(JSON.date) ?? .null, "modifiedAt": .date(modified),
         "lastOpenedAt": lastOpened.map(JSON.date) ?? .null, "lastAccessedAt": accessed.map(JSON.date) ?? .null,
         "fileType": .string(contentType.identifier), "extension": .text(fileExtension), "thumbnail": .text(thumbnail)]
    }
}

struct DirectoryContents {
    let revision: String
    let entries: [FileItem]
    let deviceNumber: Int32
}

final class ScopedFiles: @unchecked Sendable {
    private let roots: [String: LocalRoot]
    private let state: LocalState
    private let queue = DispatchQueue(label: "FileSharing.file-io", qos: .utility)
    static let chunk = 262_144
    private static let workName = ".filesharing-work"

    init(roots: [LocalRoot], state: LocalState) {
        self.roots = Dictionary(uniqueKeysWithValues: roots.map { ($0.rootKey, $0) })
        self.state = state
    }

    static func controlComponent(_ component: Substring) -> Bool {
        let name = component.lowercased()
        return name.hasPrefix(".filesharing-") || name.hasPrefix(".env") || [
            ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config", ".npmrc", ".netrc", ".git-credentials",
            ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zsh_history", ".bashrc", ".bash_history",
            ".profile", ".bash_profile", ".trash", ".local", ".docker", ".password-store", ".cursor",
            ".codex", ".agents", ".gemini", ".claude", ".cache", ".git"
        ].contains(name)
    }

    static func failure(_ code: Int32 = errno) -> AgentError {
        switch code {
        case EACCES, EPERM: return AgentError("filesystem_access_denied")
        case ELOOP, EXDEV: return AgentError("permission_denied")
        case ENOENT, ENOTDIR: return AgentError("not_found")
        case EEXIST: return AgentError("already_exists")
        case ENOTEMPTY: return AgentError("directory_not_empty")
        case ENOSPC, EDQUOT: return AgentError("limit_reached")
        default: return AgentError("device_operation_failed")
        }
    }

    func command(_ kind: String, _ input: JSON) async throws -> JSON {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try self.run(kind, input) }) }
        }
    }

    func watchTarget(rootKey: String, path: String) async throws -> (LocalRoot, DirectoryContents) {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result {
                    let root = try self.root(rootKey)
                    return (root, try self.list(root: root, relative: path))
                })
            }
        }
    }

    private func root(_ key: String) throws -> LocalRoot {
        guard let root = roots[key] else { throw AgentError("permission_denied") }
        return root
    }

    private func components(_ input: String, write: Bool = false) throws -> [String] {
        if input.isEmpty { return [] }
        let split = input.split(separator: "/", omittingEmptySubsequences: false)
        guard input.utf8.count <= 12_000, split.count <= 40,
              !input.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !input.contains("\\"),
              split.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 && !Self.controlComponent($0) })
        else { throw AgentError("invalid_path") }
        if write && split.contains(where: { item in
            let suffix = item.split(separator: ".").last?.lowercased() ?? ""
            return ["app", "pkg", "kext", "bundle", "plugin", "dylib", "framework", "command"].contains(suffix)
        }) { throw AgentError("permission_denied") }
        return split.map(String.init)
    }

    private func openRoot(_ root: LocalRoot) throws -> Descriptor {
        let descriptor = try Descriptor(open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let info = try descriptor.info()
        let volumeMatches = root.volumeUUID.map { $0 == descriptor.volumeUUID } ?? (info.st_dev == root.deviceNumber)
        guard volumeMatches, info.st_ino == root.inode else { throw AgentError("root_identity_changed") }
        return descriptor
    }

    private func libraryAccessDenied(_ root: LocalRoot, _ parts: ArraySlice<String>, write: Bool = false) -> Bool {
        guard root.isHome, parts.first?.caseInsensitiveCompare("Library") == .orderedSame else { return false }
        if write { return true }
        let subfolders = parts.dropFirst()
        if subfolders.first?.caseInsensitiveCompare("Keychains") == .orderedSame { return true }
        guard subfolders.first?.caseInsensitiveCompare("Application Support") == .orderedSame,
              let application = subfolders.dropFirst().first?.lowercased() else { return false }
        return application == "filesharingservicedemo" || application == "filesharingagent"
    }

    private func traverse(_ root: LocalRoot, _ components: ArraySlice<String>) throws -> Descriptor {
        guard !libraryAccessDenied(root, components) else { throw AgentError("permission_denied") }
        var directory = try openRoot(root)
        let deviceNumber = try directory.info().st_dev
        for component in components {
            let next = try Descriptor(openat(directory.fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
            guard try next.info().st_dev == deviceNumber else { throw AgentError("permission_denied") }
            directory = next
        }
        return directory
    }

    private func parent(_ root: LocalRoot, _ relative: String, write: Bool) throws -> (Descriptor, String) {
        let parts = try components(relative, write: write)
        guard let last = parts.last else { throw AgentError("invalid_path") }
        try validateAccess(root, parts, write: write)
        return (try traverse(root, parts.dropLast()), last)
    }

    private func validateAccess(_ root: LocalRoot, _ parts: [String], write: Bool) throws {
        guard !libraryAccessDenied(root, parts[...], write: write) else { throw AgentError("permission_denied") }
        guard write, let component = parts.first else { return }
        let folder = component.lowercased()
        let protectedFolder = DevicePermissions.folders[folder] != nil
        guard root.writable || (root.isHome && parts.count > 1 && DevicePermissions.folders[folder] == component &&
            DevicePermissions.allowsWriting(folder, state: state)) else { throw AgentError("permission_denied") }
        if root.isHome, parts.count == 1,
           protectedFolder || ["music", "pictures", "movies", "applications", "public"].contains(folder) {
            throw AgentError("permission_denied")
        }
    }

    private func metadata(root: LocalRoot, path: String) throws -> FileItem {
        if path.isEmpty {
            let descriptor = try openRoot(root)
            return FileItem(name: root.label, relative: "", root: root, info: try descriptor.info())
        }
        let (directory, name) = try parent(root, path, write: false)
        return try item(root, directory, name, path)
    }

    private func item(_ root: LocalRoot, _ directory: Descriptor, _ name: String, _ path: String) throws -> FileItem {
        var data = stat()
        guard fstatat(directory.fd, name, &data, AT_SYMLINK_NOFOLLOW) == 0 else { throw Self.failure() }
        return FileItem(name: name, relative: path, root: root, info: data)
    }

    private func names(_ dir: Descriptor, maximum: Int = 50_000) throws -> [String] {
        let copy = dup(dir.fd)
        guard copy >= 0 else { throw Self.failure() }
        guard let source = fdopendir(copy) else {
            close(copy)
            throw Self.failure()
        }
        defer { closedir(source) }
        rewinddir(source)
        var list = [String]()
        while true {
            errno = 0
            guard let entry = readdir(source) else {
                if errno != 0 { throw Self.failure() }
                return list
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) {
                    String(validatingCString: $0)
                }
            }
            guard let name, name != ".", name != ".." else { continue }
            list.append(name)
            if list.count > maximum { throw AgentError("too_large") }
        }
    }

    private func list(root: LocalRoot, relative: String) throws -> DirectoryContents {
        let path = try components(relative)
        let directory = try traverse(root, path[...])
        let before = try directory.info()
        var entries = [FileItem]()
        let inLibrary = root.isHome && path.first?.caseInsensitiveCompare("Library") == .orderedSame
        for name in try names(directory).sorted() {
            guard (try? components(name)) != nil,
                  !inLibrary || !libraryAccessDenied(root, (path + [name])[...])
            else { continue }
            let child = relative.isEmpty ? name : relative + "/" + name
            do {
                entries.append(try item(root, directory, name, child))
            } catch let error as AgentError where error.code == "not_found" {
                throw AgentError("snapshot_changed")
            }
        }
        let after = try directory.info()
        guard before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else {
            throw AgentError("snapshot_changed")
        }
        var digest = SHA256()
        for entry in entries {
            digest.update(data: Data(entry.name.utf8))
            digest.update(data: [0])
            digest.update(data: Data(entry.version.utf8))
        }
        return DirectoryContents(revision: Data(digest.finalize()).base64URL, entries: entries, deviceNumber: before.st_dev)
    }

    private func page(_ root: LocalRoot, _ path: String, _ input: JSON) throws -> JSON {
        let listing = try list(root: root, relative: path)
        let offset = try input.requireInt("offset")
        let limit = try input.requireInt("limit")
        let sort = input["sort"].string ?? "name"
        let descending = input["descending"].bool == true
        let hidden = input["hidden"].bool == true
        guard offset >= 0, offset <= 50_000, limit > 0, limit <= 200 else { throw AgentError("invalid_request") }
        let visible = hidden ? listing.entries : listing.entries.filter { !$0.hidden }
        let opened = sort == "lastOpenedAt" ? visible.map { ($0, $0.lastOpened) } : visible.map { ($0, nil as Date?) }
        var stamp = SHA256()
        stamp.update(data: Data("\(listing.revision):\(sort):\(descending):\(hidden)".utf8))
        if sort == "lastOpenedAt" {
            for (_, date) in opened {
                stamp.update(data: Data("\(date?.timeIntervalSince1970 ?? -1);".utf8))
            }
        }
        let revision = Data(stamp.finalize()).base64URL
        if let expected = input["revision"].string, expected != revision { throw AgentError("snapshot_changed") }
        let sorted = opened.sorted { lhs, rhs in
            let a = lhs.0
            let b = rhs.0
            let result: ComparisonResult
            switch sort {
            case "size": result = cmp(a.kind == "file" ? a.info.st_size : 0, b.kind == "file" ? b.info.st_size : 0)
            case "createdAt": result = cmp(a.created ?? .distantPast, b.created ?? .distantPast)
            case "modifiedAt": result = cmp(a.modified, b.modified)
            case "lastOpenedAt": result = cmp(lhs.1 ?? .distantPast, rhs.1 ?? .distantPast)
            case "type": result = cmp(a.contentType.identifier, b.contentType.identifier)
            default: result = .orderedSame
            }
            if result == .orderedSame {
                return sort == "name" && descending ? b.name.utf8.lexicographicallyPrecedes(a.name.utf8)
                    : a.name.utf8.lexicographicallyPrecedes(b.name.utf8)
            }
            return result == (descending ? .orderedDescending : .orderedAscending)
        }
        let page = sorted.dropFirst(Int(offset)).prefix(Int(limit)).map { $0.0.value }
        let next = Int(offset) + page.count
        return ["revision": .string(revision), "items": .array(page), "total": .integer(Int64(sorted.count)),
                "snapshotRevision": .string(listing.revision),
                "nextOffset": next < sorted.count ? .integer(Int64(next)) : .null]
    }

    private func cmp<T: Comparable>(_ first: T, _ second: T) -> ComparisonResult {
        if first < second { return .orderedAscending }
        if second < first { return .orderedDescending }
        return .orderedSame
    }

    private func summarize(_ root: LocalRoot, _ path: String) throws -> JSON {
        var files: Int64 = 0
        var folders: Int64 = 0
        var size: Int64 = 0
        var complete = true
        var pending = [path]
        while let current = pending.popLast(), files + folders < 50_000 {
            let snapshot: DirectoryContents
            do { snapshot = try list(root: root, relative: current) }
            catch let error as AgentError where ["permission_denied", "filesystem_access_denied", "too_large"].contains(error.code) {
                complete = false
                continue
            }
            for child in snapshot.entries {
                if files + folders >= 50_000 { return ["folderSize": .integer(size), "filesCount": .integer(files),
                    "foldersCount": .integer(folders), "complete": false] }
                if child.kind == "directory" {
                    folders += 1
                    if child.info.st_dev == snapshot.deviceNumber { pending.append(child.relative) }
                    else { complete = false }
                } else {
                    files += 1
                    if child.kind == "file" { size += child.info.st_size }
                }
            }
        }
        return ["folderSize": .integer(size), "filesCount": .integer(files), "foldersCount": .integer(folders),
                "complete": .boolean(complete && pending.isEmpty)]
    }

    private func thumbnail(_ root: LocalRoot, _ path: String, version: String) throws -> JSON {
        let entry = try metadata(root: root, path: path)
        guard entry.version == version, let kind = entry.thumbnail else { throw AgentError("version_mismatch") }
        var bytes: Data?
        if (kind == "image" || kind == "pdf") && entry.info.st_size <= FileThumbnail.sourceLimit {
            let (directory, name) = try parent(root, path, write: false)
            let file = try Descriptor(openat(directory.fd, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC))
            let before = try file.info()
            try guardedRegular(before)
            guard FileItem(name: name, relative: path, root: root, info: before).version == version else { throw AgentError("version_mismatch") }
            bytes = try readData(file, offset: 0, count: Int(before.st_size))
            guard FileItem(name: name, relative: path, root: root, info: try file.info()).version == version,
                  bytes?.count == Int(before.st_size) else { throw AgentError("version_mismatch") }
        }
        let png = try FileThumbnail.make(kind, type: entry.contentType, bytes: bytes)
        guard png.count <= 262_144 else { throw AgentError("too_large") }
        return ["data": .string(png.base64EncodedString())]
    }

    private func work(_ root: LocalRoot) throws -> Descriptor {
        let rootDir = try openRoot(root)
        if mkdirat(rootDir.fd, Self.workName, 0o700) != 0 && errno != EEXIST { throw Self.failure() }
        let work = try Descriptor(openat(rootDir.fd, Self.workName, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC))
        let info = try work.info()
        guard info.st_uid == getuid(), info.st_mode & 0o077 == 0, try info.st_dev == rootDir.info().st_dev
        else { throw AgentError("permission_denied") }
        return work
    }

    private func fileID(_ value: String) throws -> String {
        guard let id = UUID(uuidString: value), id.uuidString.lowercased() == value else { throw AgentError("invalid_request") }
        return value
    }

    private func guardedRegular(_ info: stat) throws {
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw AgentError("permission_denied") }
    }

    private func writeData(_ descriptor: Descriptor, _ data: Data, at offset: Int64) throws {
        try data.withUnsafeBytes { buffer in
            var sent = 0
            while sent < buffer.count {
                let count = pwrite(descriptor.fd, buffer.baseAddress!.advanced(by: sent), buffer.count - sent, offset + Int64(sent))
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Self.failure() }
                sent += count
            }
        }
    }

    private func readData(_ descriptor: Descriptor, offset: Int64, count: Int) throws -> Data {
        var data = Data(count: count)
        var read = 0
        try data.withUnsafeMutableBytes { buffer in
            while read < buffer.count {
                let result = pread(descriptor.fd, buffer.baseAddress!.advanced(by: read), buffer.count - read, offset + Int64(read))
                if result < 0 && errno == EINTR { continue }
                guard result >= 0 else { throw Self.failure() }
                if result == 0 { break }
                read += result
            }
        }
        return Data(data.prefix(read))
    }

    private func record(_ directory: Descriptor, name: String, value: JSON) throws {
        let descriptor = try Descriptor(openat(directory.fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        try writeData(descriptor, value.encoded(), at: 0)
        guard fsync(descriptor.fd) == 0 else { throw Self.failure() }
    }

    private func record(_ directory: Descriptor, name: String) throws -> JSON {
        let descriptor = try Descriptor(openat(directory.fd, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC))
        let info = try descriptor.info()
        try guardedRegular(info)
        guard info.st_size <= 20_000 else { throw AgentError("invalid_request") }
        return try JSON.decode(readData(descriptor, offset: 0, count: Int(info.st_size)))
    }

    private func run(_ kind: String, _ input: JSON) throws -> JSON {
        let root = try root(input.requireString("root"))
        let path = input["path"].string ?? ""
        switch kind {
        case "files.stat":
            let entry = try metadata(root: root, path: path)
            guard input["summary"].bool == true && entry.kind == "directory" else { return entry.value }
            guard case .object(var details) = entry.value else { throw AgentError("device_operation_failed") }
            details["folder"] = try summarize(root, path)
            return .object(details)
        case "files.list":
            return try page(root, path, input)
        case "files.thumbnail":
            return try thumbnail(root, path, version: input.requireString("version"))
        case "files.read":
            let (directory, name) = try parent(root, path, write: false)
            let descriptor = try Descriptor(openat(directory.fd, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC))
            let info = try descriptor.info()
            try guardedRegular(info)
            let offset = try input.requireInt("offset")
            let count = try input.requireInt("count")
            let before = FileItem(name: name, relative: path, root: root, info: info)
            guard before.version == input["version"].string else { throw AgentError("version_mismatch") }
            guard offset >= 0, count > 0, count <= Self.chunk, offset <= info.st_size - count else { throw AgentError("invalid_offset") }
            let bytes = try readData(descriptor, offset: offset, count: Int(count))
            let after = FileItem(name: name, relative: path, root: root, info: try descriptor.info())
            guard before.version == after.version, bytes.count == count else { throw AgentError("version_mismatch") }
            return ["data": .string(bytes.base64EncodedString())]
        case "files.mkdir":
            let (directory, name) = try parent(root, path, write: true)
            guard mkdirat(directory.fd, name, 0o700) == 0 else { throw Self.failure() }
            return try item(root, directory, name, path).value
        case "files.move":
            return try move(root, path, input)
        case "files.trash":
            return try trash(root, path, input)
        case "files.purge":
            return try purge(root, path, input)
        case "files.write":
            let _ = try parent(root, path, write: true)
            return try stage(root, input)
        case "files.commit":
            return try commit(root, path, input)
        case "files.abandon":
            if path.isEmpty {
                guard root.writable else { throw AgentError("permission_denied") }
            } else {
                try validateAccess(root, components(path, write: true), write: true)
            }
            let directory = try work(root)
            let id = try fileID(input.requireString("transferId"))
            _ = unlinkat(directory.fd, id + ".part", 0)
            _ = unlinkat(directory.fd, id + ".intent", 0)
            return [:]
        default:
            throw AgentError("unsupported")
        }
    }

    private func move(_ root: LocalRoot, _ path: String, _ input: JSON) throws -> JSON {
        let (source, name) = try parent(root, path, write: true)
        let before = try item(root, source, name, path)
        guard before.version == input["version"].string else { throw AgentError("version_mismatch") }
        if before.kind == "file" { try guardedRegular(before.info) }
        let target = try input.requireString("destination")
        let targetRoot = try self.root(input["destinationRoot"].string ?? root.rootKey)
        let (destination, targetName) = try parent(targetRoot, target, write: true)
        guard try source.info().st_dev == destination.info().st_dev else { throw AgentError("cross_volume") }
        guard renameatx_np(source.fd, name, destination.fd, targetName, UInt32(RENAME_EXCL)) == 0 else { throw Self.failure() }
        return try item(targetRoot, destination, targetName, target).value
    }

    private func trash(_ root: LocalRoot, _ path: String, _ input: JSON) throws -> JSON {
        let (source, name) = try parent(root, path, write: true)
        let before = try item(root, source, name, path)
        guard before.version == input["version"].string else { throw AgentError("version_mismatch") }
        let home = try Descriptor(open(LocalState.home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        if mkdirat(home.fd, ".Trash", 0o700) != 0 && errno != EEXIST { throw Self.failure() }
        let destination = try Descriptor(openat(home.fd, ".Trash", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let info = try destination.info()
        guard try info.st_dev == source.info().st_dev, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw AgentError("trash_unavailable")
        }
        var targetName = name
        if renameatx_np(source.fd, name, destination.fd, targetName, UInt32(RENAME_EXCL)) != 0 {
            guard errno == EEXIST else { throw Self.failure() }
            targetName = try fileID(input.requireString("recoveryId")) + "-" + String(name.prefix(48))
            guard renameatx_np(source.fd, name, destination.fd, targetName, UInt32(RENAME_EXCL)) == 0 else { throw Self.failure() }
        }
        return ["path": .string(path), "trashName": .string(targetName)]
    }

    private func purge(_ root: LocalRoot, _ path: String, _ input: JSON) throws -> JSON {
        let (source, name) = try parent(root, path, write: true)
        let id = try fileID(input.requireString("recoveryId")) + ".delete"
        let staging = try work(root)
        let deviceNumber = try source.info().st_dev
        guard try staging.info().st_dev == deviceNumber else { throw AgentError("cross_volume") }
        var staged = stat()
        if fstatat(staging.fd, id, &staged, AT_SYMLINK_NOFOLLOW) != 0 {
            let entry = try item(root, source, name, path)
            guard entry.version == input["version"].string else { throw AgentError("version_mismatch") }
            if entry.kind != "directory" {
                guard unlinkat(source.fd, name, 0) == 0 else { throw Self.failure() }
                return [:]
            }
            if input["recursive"].bool != true {
                guard unlinkat(source.fd, name, AT_REMOVEDIR) == 0 else { throw Self.failure() }
                return [:]
            }
            let opened = try Descriptor(openat(source.fd, name, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC))
            guard try opened.info().st_dev == deviceNumber else { throw AgentError("permission_denied") }
            try preflightPurge(opened, on: deviceNumber)
            guard renameatx_np(source.fd, name, staging.fd, id, UInt32(RENAME_EXCL)) == 0 else { throw Self.failure() }
        }
        do {
            try removeTree(staging, id, on: deviceNumber, depth: 0)
        } catch {
            _ = renameatx_np(staging.fd, id, source.fd, name, UInt32(RENAME_EXCL))
            throw AgentError("delete_incomplete")
        }
        return [:]
    }

    private func preflightPurge(_ directory: Descriptor, on device: Int32, depth: Int = 0, remaining: Int = 50_000) throws {
        var budget = remaining
        try verifyPurge(directory, on: device, depth: depth, budget: &budget)
    }

    private func verifyPurge(_ directory: Descriptor, on device: Int32, depth: Int, budget: inout Int) throws {
        guard depth < 40 else { throw AgentError("too_large") }
        for name in try names(directory, maximum: budget) {
            guard !Self.controlComponent(Substring(name)) else { throw AgentError("permission_denied") }
            budget -= 1
            guard budget >= 0 else { throw AgentError("too_large") }
            var info = stat()
            guard fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw Self.failure() }
            guard info.st_dev == device else { throw AgentError("permission_denied") }
            if info.st_mode & S_IFMT == S_IFDIR {
                let next = try Descriptor(openat(directory.fd, name, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC))
                guard try next.info().st_dev == device else { throw AgentError("permission_denied") }
                try verifyPurge(next, on: device, depth: depth + 1, budget: &budget)
            }
        }
    }

    private func removeTree(_ parent: Descriptor, _ name: String, on device: Int32, depth: Int) throws {
        guard depth < 40, !Self.controlComponent(Substring(name)) else { throw AgentError("permission_denied") }
        var info = stat()
        guard fstatat(parent.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw Self.failure() }
        guard info.st_dev == device else { throw AgentError("permission_denied") }
        let isDirectory = info.st_mode & S_IFMT == S_IFDIR
        if isDirectory {
            let child = try Descriptor(openat(parent.fd, name, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC))
            guard try child.info().st_dev == device else { throw AgentError("permission_denied") }
            for subitem in try names(child) {
                try removeTree(child, subitem, on: device, depth: depth + 1)
            }
        }
        guard unlinkat(parent.fd, name, isDirectory ? AT_REMOVEDIR : 0) == 0 else { throw Self.failure() }
    }

    private func stage(_ root: LocalRoot, _ input: JSON) throws -> JSON {
        let id = try fileID(input.requireString("transferId"))
        let offset = try input.requireInt("offset")
        guard offset >= 0, offset <= 64 * 1024 * 1024 * 1024,
              let bytes = Data(base64Encoded: try input.requireString("data")),
              !bytes.isEmpty, bytes.count <= Self.chunk else { throw AgentError("invalid_offset") }
        let directory = try work(root)
        let file = try Descriptor(openat(directory.fd, id + ".part", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | O_CREAT, 0o600))
        let info = try file.info()
        try guardedRegular(info)
        if offset < info.st_size {
            let old = try readData(file, offset: offset, count: bytes.count)
            guard old == bytes else { throw AgentError("invalid_offset") }
        } else {
            guard offset == info.st_size else { throw AgentError("invalid_offset") }
            do {
                try writeData(file, bytes, at: offset)
                guard fsync(file.fd) == 0 else { throw Self.failure() }
            } catch {
                _ = ftruncate(file.fd, offset)
                throw error
            }
        }
        return ["offset": .integer(try file.info().st_size)]
    }

    private func commit(_ root: LocalRoot, _ path: String, _ input: JSON) throws -> JSON {
        let (destination, name) = try parent(root, path, write: true)
        let directory = try work(root)
        let id = try fileID(input.requireString("transferId"))
        let length = try input.requireInt("length")
        let intent = id + ".intent"
        let expected = input["version"].string
        let previous = try? record(directory, name: intent)
        let current = try? item(root, destination, name, path)
        if let previous, previous["path"].string == path, let current,
           previous["inode"].string == String(current.info.st_ino), current.info.st_size == length {
            return current.value
        }
        let flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (length == 0 ? O_CREAT : 0)
        let staged = try Descriptor(openat(directory.fd, id + ".part", flags, 0o600))
        let info = try staged.info()
        try guardedRegular(info)
        guard info.st_size == length else { throw AgentError("invalid_offset") }
        if let current {
            try guardedRegular(current.info)
            guard expected == current.version else { throw AgentError("version_mismatch") }
        } else if expected != nil {
            throw AgentError("version_mismatch")
        }
        if let previous {
            guard previous["path"].string == path, previous["inode"].string == String(info.st_ino) else {
                throw AgentError("invalid_request")
            }
        } else {
            try record(directory, name: intent, value: ["path": .string(path), "inode": .string(String(info.st_ino))])
        }
        if current == nil {
            guard renameatx_np(directory.fd, id + ".part", destination.fd, name, UInt32(RENAME_EXCL)) == 0 else { throw Self.failure() }
        } else {
            guard renameatx_np(directory.fd, id + ".part", destination.fd, name, UInt32(RENAME_SWAP)) == 0 else { throw Self.failure() }
            _ = unlinkat(directory.fd, id + ".part", 0)
        }
        return try item(root, destination, name, path).value
    }
}
