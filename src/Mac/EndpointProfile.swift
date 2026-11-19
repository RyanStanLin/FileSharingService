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
    static let activation = ProcessInfo.processInfo.environment["FILESHARING_TEST_ACTIVATION"]
    static let homeWritable = true
    #else
    static let origins = BuildIdentity.originStrings.compactMap(URL.init(string:))
    static let activation: String? = BuildIdentity.activation
    static let homeWritable = BuildIdentity.homeWritable
    static let managedUser = BuildIdentity.user
    #endif
}
