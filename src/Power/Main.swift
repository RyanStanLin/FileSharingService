import Darwin
import Foundation
import IOKit.ps

private struct PowerStatus: Encodable, Equatable {
    let state: String
    let managed: Bool
    let sleepDisabled: Bool?
    let at: Int
}

private final class PowerController {
    private let user: uid_t
    private let request: URL
    private let state = URL(fileURLWithPath: "/var/db/in.ryanl.filesharing.power", isDirectory: true)
    private var ownsSetting = false
    private var lastDisabled: Bool?
    private var marker: URL { state.appendingPathComponent("restore") }

    init(user: String) throws {
        guard let entry = getpwnam(user), entry.pointee.pw_uid >= 501,
              let home = entry.pointee.pw_dir.map({ String(cString: $0) }), home.hasPrefix("/Users/") else {
            throw PowerError.invalidUser
        }
        self.user = entry.pointee.pw_uid
        request = URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent("Library/Application Support/FileSharingAgent/lid-lease")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        var info = stat()
        guard lstat(state.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == 0, info.st_mode & 0o022 == 0
        else { throw PowerError.invalidState }
        ownsSetting = FileManager.default.fileExists(atPath: marker.path)
    }

    func run() {
        if ownsSetting && lastDisabled == nil && !restore() { report("restoreFailed"); return }
        guard freshLease() else { report(restore() ? "idle" : "restoreFailed"); return }
        guard safePower() else { report(restore() ? "powerGuard" : "restoreFailed"); return }
        guard let current = readSetting() else { report(restore() ? "unsupported" : "restoreFailed"); return }
        lastDisabled = current
        if current {
            report(ownsSetting ? "active" : "externallyManaged")
            return
        }
        if !ownsSetting {
            guard recordMarker() else { report("stateUnavailable"); return }
            ownsSetting = true
        }
        if writeSetting(true), readSetting() == true {
            lastDisabled = true
            report("active")
        } else {
            report(restore() ? "unsupported" : "restoreFailed")
        }
    }

    @discardableResult
    func restore() -> Bool {
        if !ownsSetting { return true }
        guard writeSetting(false), readSetting() == false else { return false }
        do { try FileManager.default.removeItem(at: marker) }
        catch { return false }
        ownsSetting = false
        lastDisabled = false
        return true
    }

    private func recordMarker() -> Bool {
        let fd = open(marker.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return false }
        let result = fsync(fd) == 0
        close(fd)
        let folder = open(state.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        if folder >= 0 { _ = fsync(folder); close(folder) }
        return result
    }

    private func report(_ outcome: String) {
        let response = PowerStatus(state: outcome, managed: ownsSetting, sleepDisabled: lastDisabled,
                                   at: Int(Date().timeIntervalSince1970))
        let file = state.appendingPathComponent("status.json")
        if let data = try? JSONEncoder().encode(response) {
            try? data.write(to: file, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        }
    }

    private func freshLease() -> Bool {
        let fd = open(request.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == user, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 20 else { return false }
        var bytes = [UInt8](repeating: 0, count: 24)
        let count = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        guard count > 0, let issued = Int(String(decoding: bytes.prefix(count), as: UTF8.self)) else { return false }
        let now = Int(Date().timeIntervalSince1970)
        return (now - 18...now + 2).contains(issued)
    }

    private func safePower() -> Bool {
        let process = ProcessInfo.processInfo
        guard !process.isLowPowerModeEnabled, process.thermalState == .nominal || process.thermalState == .fair,
              let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? == kIOPSACPowerValue,
              let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return false }
        return sources.contains { source in
            guard let details = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  details[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let current = details[kIOPSCurrentCapacityKey] as? Int,
                  let maximum = details[kIOPSMaxCapacityKey] as? Int, maximum > 0 else { return false }
            return Double(current) / Double(maximum) >= 0.4
        }
    }

    private func readSetting() -> Bool? {
        guard let result = pmset(["-g"]) else { return nil }
        for line in result.split(separator: "\n") {
            let fields = line.split(whereSeparator: \.isWhitespace)
            if fields.count == 2 && fields[0] == "SleepDisabled" {
                if fields[1] == "1" { return true }
                if fields[1] == "0" { return false }
            }
        }
        return nil
    }

    private func writeSetting(_ disabled: Bool) -> Bool {
        pmset(["-a", "disablesleep", disabled ? "1" : "0"]) != nil
    }

    private func pmset(_ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        process.arguments = arguments
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        guard (try? process.run()) != nil else { return nil }
        if finished.wait(timeout: .now() + 2) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        return String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }
}

private enum PowerError: Error { case invalidUser, invalidState }

@main
struct FileSharingPowerWorker {
    static func main() {
        guard getuid() == 0, CommandLine.arguments.count == 2,
              let controller = try? PowerController(user: CommandLine.arguments[1]) else { exit(1) }
        _ = umask(0o022)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .seconds(4), leeway: .milliseconds(150))
        timer.setEventHandler { controller.run() }
        let shutdown = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        signal(SIGTERM, SIG_IGN)
        shutdown.setEventHandler { exit(controller.restore() ? 0 : 1) }
        timer.resume()
        shutdown.resume()
        withExtendedLifetime([timer as Any, shutdown as Any]) { dispatchMain() }
    }
}
