import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct LocalRoot: Codable, Sendable {
    let rootKey: String
    let label: String
    let path: String
    let writable: Bool
    let deviceNumber: Int32
    let inode: UInt64

    var isHome: Bool { path == LocalState.home.path(percentEncoded: false).trimmingSuffixSlash }
    var announcement: JSON {
        ["rootKey": .string(rootKey), "label": .string(label), "writable": .boolean(writable), "primary": .boolean(isHome)]
    }

    static func authorize(path: String, write: Bool) throws -> LocalRoot {
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
        let fd = open(absolute, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ScopedFiles.failure() }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw ScopedFiles.failure() }
        return LocalRoot(rootKey: JSON.id(), label: approved.lastPathComponent, path: absolute, writable: write,
                         deviceNumber: info.st_dev, inode: info.st_ino)
    }
}

struct Enrollment: Codable, Sendable {
    let deviceId: String
    let roots: [LocalRoot]
}

struct LocalState {
    static let bundleIdentifier = "in.ryanl.filesharing.agent"
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
            .appendingPathComponent("FileSharingAgent", isDirectory: true)
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw AgentError("unsafe_state_directory") }
    }

    func enrollment() throws -> Enrollment {
        try JSONDecoder().decode(Enrollment.self, from: Data(contentsOf: directory.appendingPathComponent("enrollment.json")))
    }

    func save(_ enrollment: Enrollment) throws {
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

    func privateKey() throws -> P256.Signing.PrivateKey {
        #if FILESHARING_TEST
        let file = directory.appendingPathComponent("test-key")
        if let bytes = try? Data(contentsOf: file) { return try .init(rawRepresentation: bytes) }
        let key = P256.Signing.PrivateKey()
        try key.rawRepresentation.write(to: file, options: .atomic)
        return key
        #else
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.bundleIdentifier,
            kSecAttrAccount as String: "device-p256",
            kSecUseDataProtectionKeychain as String: true
        ]
        let authentication = LAContext()
        authentication.interactionNotAllowed = true
        let lookup = query.merging([kSecReturnData as String: true, kSecUseAuthenticationContext as String: authentication]) { _, value in value }
        var credential: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &credential)
        if status == errSecSuccess, let value = credential as? Data {
            return try P256.Signing.PrivateKey(rawRepresentation: value)
        }
        guard status == errSecItemNotFound else { throw AgentError("identity_unavailable") }
        let generated = P256.Signing.PrivateKey()
        let properties = query.merging([
            kSecValueData as String: generated.rawRepresentation,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { _, value in value }
        let added = SecItemAdd(properties as CFDictionary, nil)
        if added == errSecDuplicateItem { return try privateKey() }
        guard added == errSecSuccess else { throw AgentError("identity_unavailable") }
        return generated
        #endif
    }
}

extension String {
    var trimmingSuffixSlash: String {
        hasSuffix("/") && count > 1 ? String(dropLast()) : self
    }
}
