import Foundation

enum EndpointProfile {
    #if FILESHARING_TEST
    static let origins: [URL] = {
        guard let input = ProcessInfo.processInfo.environment["FILESHARING_TEST_ORIGIN"],
              let url = URL(string: input), url.host == "localhost", ["http", "https"].contains(url.scheme ?? "") else {
            fatalError("An isolated loopback origin is required.")
        }
        return [url]
    }()
    static let homeWritable = ProcessInfo.processInfo.environment["FILESHARING_TEST_HOME_WRITE"] != "NO"
    static let localDemo = false
    #else
    static let origins: [URL] = {
        guard let primary = origin("FileSharingOrigin") else {
            fatalError("FileSharingService requires a valid server origin.")
        }
        if let backup = origin("FileSharingBackupOrigin"), (primary.host == "localhost") == (backup.host == "localhost") {
            return [primary, backup]
        }
        return [primary]
    }()
    static let localDemo = origins[0].host == "localhost"
    static let homeWritable = setting("FileSharingHomeWritable") != "NO"
    static let managedUser = setting("FileSharingManagedUser")

    private static func setting(_ name: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: name) as? String, !value.isEmpty else { return nil }
        return value
    }

    private static func origin(_ name: String) -> URL? {
        guard let value = setting(name), let url = URLComponents(string: value), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", url.scheme == "https" || url.scheme == "http" && host == "localhost"
        else { return nil }
        return url.url
    }
    #endif
}
