import Foundation
import Security

struct LocalRoot: Codable, Equatable, Sendable {
    let rootKey: String
    let label: String
    let path: String
    let writable: Bool
    let deviceNumber: Int32
    let inode: UInt64
    let volumeUUID: UUID?
    let followsHomePolicy: Bool?

    var isHome: Bool { path == LocalState.home.path(percentEncoded: false).trimmingSuffixSlash }
    var hasHomePolicy: Bool { isHome && followsHomePolicy != false }
    var announcement: JSON {
        ["rootKey": .string(rootKey), "label": .string(label), "writable": .boolean(writable), "primary": .boolean(isHome)]
    }

    static func authorize(path: String, write: Bool, followsHomePolicy: Bool = false) throws -> LocalRoot {
        guard path.hasPrefix("/") else { throw AgentError("absolute_path_required") }
        let home = LocalState.home.path(percentEncoded: false).trimmingSuffixSlash
        let approved = URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath()
        let absolute = approved.path(percentEncoded: false).trimmingSuffixSlash
        let homePrefix = home.trimmingSuffixSlash + "/"
        if absolute == home {
            guard home != "/", getuid() != 0 else { throw AgentError("unshareable_directory") }
        } else if absolute.hasPrefix(homePrefix) {
            let first = absolute.dropFirst(homePrefix.count).split(separator: "/").first ?? ""
            guard !first.isEmpty, !first.hasPrefix("."), first.lowercased() != "library",
                  !write || first.lowercased() != "applications" else { throw AgentError("unshareable_directory") }
        } else if absolute == "/Applications" || absolute.hasPrefix("/Applications/") {
            guard !write else { throw AgentError("unshareable_directory") }
        } else if !absolute.hasPrefix("/Volumes/") && !absolute.hasPrefix("/Users/Shared/") {
            throw AgentError("unshareable_directory")
        }
        let scopedPath = absolute == home ? "" :
            absolute.hasPrefix(homePrefix) ? String(absolute.dropFirst(homePrefix.count)) : absolute
        guard !scopedPath.split(separator: "/").contains(where: ScopedFiles.controlComponent) else {
            throw AgentError("unshareable_directory")
        }
        let descriptor = try Descriptor(open(absolute, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let info = try descriptor.info()
        return LocalRoot(rootKey: JSON.id(), label: approved.lastPathComponent, path: absolute, writable: write,
                         deviceNumber: info.st_dev, inode: info.st_ino, volumeUUID: descriptor.volumeUUID,
                         followsHomePolicy: followsHomePolicy)
    }

    func upgradingVolumeIdentity() -> LocalRoot {
        guard volumeUUID == nil,
              let descriptor = try? Descriptor(open(path, O_EVTONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)),
              let info = try? descriptor.info(), info.st_ino == inode,
              let uuid = descriptor.volumeUUID else { return self }
        // Only the OS-selected home can recover from a changed legacy device number.
        guard info.st_dev == deviceNumber || (isHome && info.st_uid == getuid()) else { return self }
        return LocalRoot(rootKey: rootKey, label: label, path: path, writable: writable,
                         deviceNumber: info.st_dev, inode: inode, volumeUUID: uuid, followsHomePolicy: followsHomePolicy)
    }

    func applyingHomePolicy(writable: Bool) -> LocalRoot {
        guard hasHomePolicy, self.writable != writable || followsHomePolicy == nil else { return self }
        return LocalRoot(rootKey: rootKey, label: label, path: path, writable: writable,
                         deviceNumber: deviceNumber, inode: inode, volumeUUID: volumeUUID, followsHomePolicy: true)
    }
}

struct Enrollment: Codable, Sendable {
    let deviceId: String
    let roots: [LocalRoot]
    let notificationKey: String?
}

struct LocalState: Sendable {
    static let home: URL = {
        #if FILESHARING_TEST
        guard let path = ProcessInfo.processInfo.environment["FILESHARING_TEST_HOME"], path.hasPrefix("/") else {
            fatalError("An isolated FILESHARING_TEST_HOME is required.")
        }
        return URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath()
        #else
        return FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath()
        #endif
    }()

    let directory: URL

    init() throws {
        #if FILESHARING_TEST
        guard let test = ProcessInfo.processInfo.environment["FILESHARING_TEST_STATE"] else { throw AgentError("missing_test_state") }
        directory = URL(fileURLWithPath: test, isDirectory: true)
        #else
        directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true)
            .appendingPathComponent(EndpointProfile.localDemo ? "FileSharingServiceDemo" : "FileSharingAgent", isDirectory: true)
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw AgentError("unsafe_state_directory") }
    }

    private func enrollment() throws -> Enrollment {
        try JSONDecoder().decode(Enrollment.self, from: Data(contentsOf: directory.appendingPathComponent("enrollment.json")))
    }

    func configuredRoots() throws -> [LocalRoot] {
        try withEnrollmentLock { try enrollment().roots }
    }

    func loadOrCreate(homeWritable: Bool) throws -> Enrollment {
        try withEnrollmentLock {
            let stored: Enrollment
            do {
                stored = try enrollment()
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                let home = try LocalRoot.authorize(path: Self.home.path(percentEncoded: false), write: homeWritable,
                                                   followsHomePolicy: true)
                let local = Enrollment(deviceId: JSON.id(), roots: [home], notificationKey: try Self.makeNotificationKey())
                try save(local)
                return local
            }
            let roots = stored.roots.map { $0.upgradingVolumeIdentity().applyingHomePolicy(writable: homeWritable) }
            if roots == stored.roots && stored.notificationKey != nil { return stored }
            let key = try stored.notificationKey ?? Self.makeNotificationKey()
            let upgraded = Enrollment(deviceId: stored.deviceId, roots: roots, notificationKey: key)
            try save(upgraded)
            return upgraded
        }
    }

    func updateRoots(_ update: ([LocalRoot]) throws -> [LocalRoot]) throws -> Int {
        try withEnrollmentLock {
            let stored = try enrollment()
            let roots = try update(stored.roots)
            try save(Enrollment(deviceId: stored.deviceId, roots: roots, notificationKey: stored.notificationKey))
            return roots.count
        }
    }

    private static func makeNotificationKey() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw AgentError("random_key_unavailable") }
        return Data(bytes).base64URL
    }

    private func withEnrollmentLock<T>(_ action: () throws -> T) throws -> T {
        let lock = directory.appendingPathComponent("enrollment.lock").path
        let fd = open(lock, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ScopedFiles.failure() }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw ScopedFiles.failure() }
        return try action()
    }

    private func save(_ enrollment: Enrollment) throws {
        let target = directory.appendingPathComponent("enrollment.json")
        try JSONEncoder().encode(enrollment).write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }

    func loadPending() -> [JSON] {
        guard let bytes = try? Data(contentsOf: directory.appendingPathComponent("pending.json")),
              bytes.count <= 1_048_576 else { return [] }
        return (try? JSON.decode(bytes).array) ?? []
    }

    func savePending(_ frames: [JSON]) {
        guard let bytes = try? JSON.array(frames).encoded(), bytes.count <= 1_048_576 else { return }
        let file = directory.appendingPathComponent("pending.json")
        try? bytes.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

extension String {
    var trimmingSuffixSlash: String {
        hasSuffix("/") && count > 1 ? String(dropLast()) : self
    }
}
