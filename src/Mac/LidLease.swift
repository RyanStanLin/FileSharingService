import Foundation
import IOKit

struct LidLease {
    let directory: URL
    private var request: URL { directory.appendingPathComponent("lid-lease") }

    func update(enabled: Bool) {
        #if !FILESHARING_TEST
        let helper = FileManager.default.fileExists(atPath: "/Library/PrivilegedHelperTools/in.ryanl.filesharing.power")
        if enabled && helper {
            let time = Int(Date().timeIntervalSince1970)
            try? Data(String(time).utf8).write(to: request, options: .atomic)
        } else if FileManager.default.fileExists(atPath: request.path) {
            try? FileManager.default.removeItem(at: request)
        }
        #endif
    }

    func status() -> JSON {
        #if FILESHARING_TEST
        return ["state": "testIsolated", "configuredByHelper": false, "lidClosed": .null]
        #else
        var result: [String: JSON] = ["state": "systemControlled", "configuredByHelper": false, "lidClosed": lidClosed()]
        let url = URL(fileURLWithPath: "/var/db/in.ryanl.filesharing.power/status.json")
        if let bytes = try? Data(contentsOf: url), bytes.count < 2048, let status = try? JSON.decode(bytes),
           let when = status["at"].int, abs(Date().timeIntervalSince1970 - Double(when)) < 20 {
            result["state"] = status["state"]
            result["configuredByHelper"] = status["managed"]
            result["sleepDisabled"] = status["sleepDisabled"]
            result["checkedAt"] = .date(Date(timeIntervalSince1970: Double(when)))
        }
        return .object(result)
        #endif
    }

    private func lidClosed() -> JSON {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != IO_OBJECT_NULL else { return .null }
        defer { IOObjectRelease(service) }
        guard let value = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString,
                                                           kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool
        else { return .null }
        return .boolean(value)
    }
}
