import AppKit
import CoreGraphics
import CryptoKit
import DiskArbitration
import Foundation
import IOKit
import IOKit.ps
import IOKit.pwr_mgt
import IOKit.storage
import SystemConfiguration
import Darwin

struct Sampling: Equatable {
    var cpu: Int64 = 0
    var memory: Int64 = 0
    var disk: Int64 = 60
    var battery: Int64 = 60
    var displays: Int64 = 0
    var keepAwake = true

    init() {}

    init(_ value: JSON) {
        cpu = Self.interval(value["cpu"])
        memory = Self.interval(value["memory"])
        disk = Self.interval(value["disk"])
        battery = Self.interval(value["battery"])
        displays = Self.interval(value["displays"])
        keepAwake = value["keepAwake"].bool ?? true
    }

    private static func interval(_ value: JSON) -> Int64 {
        guard let seconds = value.int, (5...3600).contains(seconds) else { return 0 }
        return seconds
    }
}

private final class DiskObserver {
    let changed: () -> Void
    private let session: DASession

    init?(changed: @escaping () -> Void) {
        guard let session = DASessionCreate(kCFAllocatorDefault) else { return nil }
        self.changed = changed
        self.session = session
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        DARegisterDiskAppearedCallback(session, nil, { _, context in DiskObserver.signal(context) }, pointer)
        DARegisterDiskDisappearedCallback(session, nil, { _, context in DiskObserver.signal(context) }, pointer)
        DARegisterDiskDescriptionChangedCallback(session, nil, nil, { _, _, context in DiskObserver.signal(context) }, pointer)
        DASessionSetDispatchQueue(session, .main)
    }

    private static func signal(_ value: UnsafeMutableRawPointer?) {
        if let value { Unmanaged<DiskObserver>.fromOpaque(value).takeUnretainedValue().changed() }
    }

    deinit { DASessionSetDispatchQueue(session, nil) }
}

@MainActor
final class Telemetry {
    static let version = "0.3.0"
    private let boot = Date()
    private let roots: [LocalRoot]
    private let emit: (String, JSON, Bool) -> Void
    private var sampling = Sampling()
    private var policyCheckedAt = Date.distantPast
    private var last = [String: Date]()
    private var lastValues = [String: JSON]()
    private var cpuBaseline: (busy: UInt64, total: UInt64)?
    private var installed = [String: JSON]()
    private var icons = [String: Data]()
    private var storage = [String: JSON]()
    private let permissions: DevicePermissions
    private let lid: LidLease
    private var assertion: IOPMAssertionID = 0
    private var observers = [NSObjectProtocol]()
    private var diskObserver: DiskObserver?
    private var installedObservers = [NativeDirectoryStream]()
    private var inventoryRefresh: Task<Void, Never>?
    private var externalPower: JSON = .null
    private var asleep = false
    private var displaySleeping = false
    private var lockState = "unknown"
    private var started = false

    init(roots: [LocalRoot], state: LocalState, emit: @escaping (String, JSON, Bool) -> Void) {
        self.roots = roots
        self.emit = emit
        self.permissions = DevicePermissions(roots: roots)
        self.lid = LidLease(directory: state.directory)
    }

    func start() async {
        if !started {
            started = true
            observe()
        }
        updatePower()
        for topic in ["identity", "system", "power", "locale", "network", "agent", "roots", "displays",
                      "permissions", "apps-running", "storage"] {
            await sample(topic, force: true)
        }
        if sampling.disk > 0 { await sample("disk", force: true) }
        if sampling.battery > 0 { await sample("battery", force: true) }
        await sample("apps-installed", force: true)
    }

    func setPolicy(_ value: Sampling) {
        policyCheckedAt = Date()
        if value.cpu == 0 { cpuBaseline = nil }
        if sampling != value {
            sampling = value
            updatePower()
            publish("power", power(), force: true)
        }
    }

    func tick() async {
        for (topic, interval) in [("agent", Int64(60)), ("system", 60), ("network", 30), ("power", 4),
                                  ("cpu", sampling.cpu), ("memory", sampling.memory), ("disk", sampling.disk),
                                  ("battery", sampling.battery), ("displays", sampling.displays), ("apps-installed", 600)] {
            if interval > 0 && Date().timeIntervalSince(last[topic] ?? .distantPast) >= Double(interval) {
                await sample(topic, force: topic != "power")
            }
        }
    }

    func refresh(_ topics: [JSON]) async -> JSON {
        for topic in topics.compactMap(\.string).prefix(17) { await sample(topic, force: true) }
        return ["refreshed": .array(topics)]
    }

    func diagnostic(_ name: String) throws -> JSON {
        let data: JSON
        switch name {
        case "osVersion":
            data = ["version": .string(ProcessInfo.processInfo.operatingSystemVersionString), "build": .text(Self.sysctl("kern.osversion"))]
        case "uptime":
            data = ["seconds": .integer(Int64(ProcessInfo.processInfo.systemUptime))]
        case "diskSpace":
            data = Self.disks()
        case "agentHealth":
            data = agent()
        default:
            throw AgentError("unsupported")
        }
        return ["stdout": .string(String(decoding: try data.encoded(), as: UTF8.self)), "stderr": "", "exitCode": 0, "data": data]
    }

    func permission(_ id: String) async throws -> JSON {
        let result = try await permissions.request(id) { [weak self] in
            if let self { self.publish("permissions", self.permissions.snapshot(), force: true) }
        }
        publish("permissions", permissions.snapshot(), force: true)
        return ["permission": .string(id), "result": result]
    }

    func icon(_ id: String) throws -> JSON {
        if let saved = icons[id] { return ["data": .string(saved.base64EncodedString())] }
        let candidate = installed[id] ?? (lastValues["apps-running"]?.array?.first(where: { $0["applicationId"].string == id }))
        guard let appPath = candidate?["installPath"].string else { throw AgentError("not_found") }
        let icon = NSWorkspace.shared.icon(forFile: appPath)
        let image = NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
            icon.draw(in: rect)
            return true
        }
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]), png.count <= 131_072 else { throw AgentError("not_found") }
        if icons.count >= 32 { icons.removeAll(keepingCapacity: true) }
        icons[id] = png
        return ["data": .string(png.base64EncodedString())]
    }

    private func observe() {
        let workspace = NSWorkspace.shared.notificationCenter
        for (notification, change) in [(NSWorkspace.didLaunchApplicationNotification, "launched"),
                                       (NSWorkspace.didTerminateApplicationNotification, "terminated"),
                                       (NSWorkspace.didActivateApplicationNotification, "activated"),
                                       (NSWorkspace.didDeactivateApplicationNotification, "deactivated"),
                                       (NSWorkspace.didHideApplicationNotification, "hidden"),
                                       (NSWorkspace.didUnhideApplicationNotification, "unhidden")] {
            observers.append(workspace.addObserver(forName: notification, object: nil, queue: .main) { [weak self] event in
                let application = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let application {
                        self.emit("applications.changed", ["kind": .string(change), "application": Self.running(application),
                                                          "occurredAt": .date(Date())], false)
                    }
                    await self.sample("apps-running", force: false)
                }
            })
        }
        for (notification, state) in [(NSWorkspace.willSleepNotification, true), (NSWorkspace.didWakeNotification, false)] {
            observers.append(workspace.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.asleep = state
                    self.emit("system.changed", ["kind": state ? "sleeping" : "woke", "occurredAt": .date(Date())], false)
                    await self.sample("system", force: true)
                    await self.sample("power", force: true)
                }
            })
        }
        for (notification, state) in [(NSWorkspace.screensDidSleepNotification, true), (NSWorkspace.screensDidWakeNotification, false)] {
            observers.append(workspace.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.displaySleeping = state
                    await self?.sample("system", force: true)
                    await self?.sample("displays", force: true)
                }
            })
        }
        for (name, state) in [("com.apple.screenIsLocked", "locked"), ("com.apple.screenIsUnlocked", "unlocked")] {
            observers.append(DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name(name), object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.lockState = state
                    await self?.sample("system", force: true)
                }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.sample("displays", force: true) }
        })
        diskObserver = DiskObserver { [weak self] in Task { @MainActor in await self?.sample("storage", force: false) } }
        installedObservers = Self.inventoryPaths.compactMap { path in
            guard FileManager.default.fileExists(atPath: path) else { return nil }
            return NativeDirectoryStream(path: path) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.inventoryRefresh?.cancel()
                    self.inventoryRefresh = Task {
                        do {
                            try await Task.sleep(for: .seconds(1))
                            await self.sample("apps-installed", force: false)
                        } catch {
                        }
                    }
                }
            }
        }
    }

    private func sample(_ topic: String, force: Bool) async {
        let value: JSON
        switch topic {
        case "identity":
            value = ["name": .text(Host.current().localizedName), "hostname": .string(ProcessInfo.processInfo.hostName),
                     "username": .string(NSUserName()), "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString),
                     "osBuild": .text(Self.sysctl("kern.osversion")), "model": .text(Self.sysctl("hw.model")),
                     "cpuModel": .text(Self.sysctl("machdep.cpu.brand_string")), "architecture": .string(Self.architecture),
                     "cores": .number(ProcessInfo.processInfo.processorCount)]
        case "cpu":
            value = await cpu()
        case "memory":
            value = Self.memory()
        case "disk":
            value = Self.disks()
        case "battery":
            value = battery()
        case "power":
            updatePower()
            value = power()
        case "system":
            let uptime = ProcessInfo.processInfo.systemUptime
            value = ["uptimeSeconds": .integer(Int64(uptime)), "bootedAt": .date(Date().addingTimeInterval(-uptime)),
                     "sleepState": asleep ? "sleeping" : "awake", "displaySleeping": .boolean(displaySleeping),
                     "lockState": .string(lockState), "lockStateQuality": lockState == "unknown" ? "unavailable" : "observed"]
        case "displays":
            value = Self.displays()
        case "locale":
            value = ["language": .text(Locale.preferredLanguages.first), "timeZone": .string(TimeZone.current.identifier),
                     "region": .text(Locale.current.region?.identifier)]
        case "network":
            value = Self.network()
        case "agent":
            value = agent()
        case "roots":
            value = .array(roots.map(\.announcement))
        case "permissions":
            value = permissions.snapshot()
        case "apps-running":
            value = .array(NSWorkspace.shared.runningApplications.prefix(600).map(Self.running))
        case "apps-installed":
            let discovered = await Task.detached(priority: .utility) { Self.inventory() }.value
            if last[topic] != nil {
                diff(installed, discovered, topic: "applications.changed",
                     appeared: "installed", removed: "removed", changed: "updated")
            }
            if installed != discovered { icons.removeAll() }
            installed = discovered
            value = .array(discovered.sorted(by: { $0.key < $1.key }).map(\.value))
        case "storage":
            let found = Self.external()
            if last[topic] != nil {
                for key in Set(storage.keys).union(found.keys).sorted() {
                    let old = storage[key]
                    let new = found[key]
                    let before = old?["mountPath"].string
                    let after = new?["mountPath"].string
                    if old == nil, let new { storageEvent("inserted", new) }
                    if before != after, let old, before != nil { storageEvent("unmounted", old) }
                    if before != after, let new, after != nil { storageEvent("mounted", new) }
                    if new == nil, let old { storageEvent("removed", old) }
                }
            }
            storage = found
            value = .array(found.sorted(by: { $0.key < $1.key }).map(\.value))
        default:
            return
        }
        last[topic] = Date()
        publish(topic, value, force: force)
    }

    private func diff(_ old: [String: JSON], _ new: [String: JSON], topic: String,
                      appeared: String, removed: String, changed: String) {
        for key in Set(old.keys).union(new.keys).sorted() where old[key] != new[key] {
            let kind = old[key] == nil ? appeared : (new[key] == nil ? removed : changed)
            emit(topic, ["kind": .string(kind), "application": new[key] ?? old[key] ?? .null, "occurredAt": .date(Date())], false)
        }
    }

    private func storageEvent(_ kind: String, _ item: JSON) {
        emit("storage.changed", ["kind": .string(kind), "storage": item, "occurredAt": .date(Date())], false)
    }

    private func publish(_ topic: String, _ value: JSON, force: Bool = false) {
        if force || lastValues[topic] != value {
            lastValues[topic] = value
            emit(topic, value, true)
        }
    }

    private func agent() -> JSON {
        ["version": .string(Self.version), "startedAt": .date(boot), "uptimeSeconds": .integer(Int64(Date().timeIntervalSince(boot))),
         "health": "healthy"]
    }

    private func power() -> JSON {
        ["configured": .boolean(sampling.keepAwake), "idleAssertionActive": .boolean(assertion != 0),
         "closedLid": lid.status(), "lowPowerMode": .boolean(ProcessInfo.processInfo.isLowPowerModeEnabled),
         "sleepState": asleep ? "sleeping" : "awake", "externalPower": externalPower,
         "displaySleeping": .boolean(displaySleeping), "lockState": .string(lockState),
         "displayAndLockPolicy": "managedByMacOS"]
    }

    private func updatePower() {
        externalPower = battery()["externalPower"]
        let enabled = !EndpointProfile.localDemo && sampling.keepAwake && Date().timeIntervalSince(policyCheckedAt) < 35
        lid.update(enabled: enabled)
        #if !FILESHARING_TEST
        let suitable = externalPower.bool == true && !ProcessInfo.processInfo.isLowPowerModeEnabled
        if enabled && suitable && assertion == 0 {
            let status = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), "FileSharing managed idle policy" as CFString, &assertion)
            if status != kIOReturnSuccess { assertion = 0 }
        } else if (!enabled || !suitable) && assertion != 0 {
            IOPMAssertionRelease(assertion)
            assertion = 0
        }
        #endif
    }

    private func battery() -> JSON {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else {
            return ["externalPower": .null, "chargePercent": .null, "charging": .null]
        }
        let status = IOPSGetProvidingPowerSourceType(snapshot)?.takeUnretainedValue() as String?
        let power: JSON = status == nil ? .null : .boolean(status == kIOPSACPowerValue)
        let sources = (IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef]) ?? []
        for source in sources {
            guard let battery = IOPSGetPowerSourceDescription(snapshot, source)?.takeUnretainedValue() as? [String: Any],
                  let current = battery[kIOPSCurrentCapacityKey] as? Int, let maximum = battery[kIOPSMaxCapacityKey] as? Int,
                  maximum > 0 else { continue }
            return ["externalPower": power, "chargePercent": .decimal(Double(current) * 100 / Double(maximum)),
                    "charging": (battery[kIOPSIsChargingKey] as? Bool).map(JSON.boolean) ?? .null]
        }
        return ["externalPower": power, "chargePercent": .null, "charging": .null]
    }

    private func cpu() async -> JSON {
        guard let before = Self.processor() else { return ["usagePercent": .null] }
        let baseline = cpuBaseline
        let after: (busy: UInt64, total: UInt64)
        if baseline == nil || baseline!.total >= before.total {
            try? await Task.sleep(for: .milliseconds(180))
            after = Self.processor() ?? before
        } else {
            after = before
        }
        let start = baseline ?? before
        cpuBaseline = after
        guard after.total > start.total, after.busy >= start.busy else { return ["usagePercent": .null] }
        return ["usagePercent": .decimal(100 * Double(after.busy - start.busy) / Double(after.total - start.total))]
    }

    nonisolated private static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    nonisolated private static func sysctl(_ key: String) -> String? {
        var size = 0
        guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 0, size < 8192 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { return nil }
        return bytes.withUnsafeBufferPointer { $0.baseAddress.flatMap(String.init(validatingCString:)) }
    }

    nonisolated private static func processor() -> (busy: UInt64, total: UInt64)? {
        var reading = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let value = withUnsafeMutablePointer(to: &reading) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard value == KERN_SUCCESS else { return nil }
        let values = reading.cpu_ticks
        let busy = UInt64(values.0) + UInt64(values.1) + UInt64(values.3)
        return (busy, busy + UInt64(values.2))
    }

    nonisolated private static func memory() -> JSON {
        let total = Int64(ProcessInfo.processInfo.physicalMemory)
        var reading = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &reading) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard status == KERN_SUCCESS, total > 0 else {
            return ["totalBytes": .integer(total), "usedBytes": .null, "availableBytes": .null, "usagePercent": .null]
        }
        let available = min(total, (Int64(reading.free_count) + Int64(reading.inactive_count)) * Int64(vm_kernel_page_size))
        let used = total - available
        return ["totalBytes": .integer(total), "usedBytes": .integer(used), "availableBytes": .integer(available),
                "usagePercent": .decimal(Double(used) * 100 / Double(total))]
    }

    nonisolated private static func mounts() -> [String: JSON] {
        var list: UnsafeMutablePointer<statfs>?
        let counter = getmntinfo(&list, MNT_NOWAIT)
        guard let list, counter > 0 else { return [:] }
        var values = [String: JSON]()
        for item in UnsafeBufferPointer(start: list, count: Int(counter)) {
            var entry = item
            guard let mount = withUnsafeBytes(of: &entry.f_mntonname, { buffer in
                buffer.bindMemory(to: CChar.self).baseAddress.flatMap(String.init(validatingCString:))
            }) else { continue }
            let type = withUnsafeBytes(of: &entry.f_fstypename) {
                $0.bindMemory(to: CChar.self).baseAddress.flatMap(String.init(validatingCString:))
            }
            let total = Int64(entry.f_blocks) * Int64(entry.f_bsize)
            let free = Int64(entry.f_bavail) * Int64(entry.f_bsize)
            values[mount] = ["mountPath": .string(mount), "type": .text(type), "totalBytes": .integer(total),
                             "usedBytes": .integer(max(0, total - free)), "availableBytes": .integer(free)]
        }
        return values
    }

    nonisolated private static func disks() -> JSON {
        .array(mounts().sorted(by: { $0.key < $1.key }).map(\.value))
    }

    nonisolated private static func displays() -> JSON {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        let code = CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count)
        guard code == .success else { return ["count": .null, "items": []] }
        return ["count": .integer(Int64(count)), "items": .array(ids.prefix(Int(count)).map { id in
            let mode = CGDisplayCopyDisplayMode(id)
            let rate = mode?.refreshRate ?? 0
            return ["id": .integer(Int64(id)), "width": .number(mode?.pixelWidth), "height": .number(mode?.pixelHeight),
                    "refreshRateHz": rate > 0 ? .decimal(rate) : .null, "builtIn": .boolean(CGDisplayIsBuiltin(id) != 0),
                    "active": .boolean(CGDisplayIsActive(id) != 0)]
        })]
    }

    nonisolated static func proxySettings() -> JSON {
        let data = (SCDynamicStoreCopyProxies(nil) as? [String: Any]) ?? [:]
        let http = (data[kSCPropNetProxiesHTTPEnable as String] as? NSNumber)?.boolValue ?? false
        let https = (data[kSCPropNetProxiesHTTPSEnable as String] as? NSNumber)?.boolValue ?? false
        let pac = (data[kSCPropNetProxiesProxyAutoConfigEnable as String] as? NSNumber)?.boolValue ?? false
        return ["http": .boolean(http), "https": .boolean(https), "automatic": .boolean(pac),
                "httpHost": .text(data[kSCPropNetProxiesHTTPProxy as String] as? String),
                "httpsHost": .text(data[kSCPropNetProxiesHTTPSProxy as String] as? String)]
    }

    nonisolated static func network() -> JSON {
        var first: UnsafeMutablePointer<ifaddrs>?
        var interfaces = [JSON]()
        var tunnels = Set<String>()
        if getifaddrs(&first) == 0 {
            defer { if let first { freeifaddrs(first) } }
            var pointer = first
            while let element = pointer?.pointee {
                defer { pointer = element.ifa_next }
                guard let address = element.ifa_addr else { continue }
                let family = Int32(address.pointee.sa_family)
                guard family == AF_INET || family == AF_INET6 else { continue }
                var output = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                guard getnameinfo(address, socklen_t(address.pointee.sa_len), &output, socklen_t(output.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
                let name = String(cString: element.ifa_name)
                let up = element.ifa_flags & UInt32(IFF_UP) != 0
                let host = output.withUnsafeBufferPointer { $0.baseAddress.flatMap(String.init(validatingCString:)) }
                if up && ["utun", "tun", "ppp", "ipsec"].contains(where: { name.hasPrefix($0) }) { tunnels.insert(name) }
                interfaces.append(["name": .string(name), "address": .text(host), "family": family == AF_INET ? "ipv4" : "ipv6",
                                   "up": .boolean(up), "loopback": .boolean(element.ifa_flags & UInt32(IFF_LOOPBACK) != 0)])
            }
        }
        return ["interfaces": .array(interfaces), "proxy": proxySettings(),
                "vpn": ["state": tunnels.isEmpty ? "noTunnelObserved" : "tunnelObserved",
                        "tunnelInterfaces": .array(tunnels.sorted().map(JSON.string))]]
    }

    nonisolated private static func app(_ url: URL) -> JSON {
        let info = Bundle(url: url)?.infoDictionary ?? [:]
        let path = url.path(percentEncoded: false)
        let id = Data(SHA256.hash(data: Data(path.utf8))).base64URL
        let name = (info["CFBundleDisplayName"] ?? info["CFBundleName"]) as? String ?? url.deletingPathExtension().lastPathComponent
        return ["applicationId": .string(id), "name": .string(name), "bundleId": .text(info["CFBundleIdentifier"] as? String),
                "version": .text(info["CFBundleShortVersionString"] as? String), "build": .text(info["CFBundleVersion"] as? String),
                "installPath": .string(path), "executablePath": .text(Bundle(url: url)?.executableURL?.path(percentEncoded: false))]
    }

    private static func running(_ app: NSRunningApplication) -> JSON {
        var data: [String: JSON] = [:]
        if let url = app.bundleURL, case .object(let value) = Self.app(url) { data = value }
        data["name"] = .text(app.localizedName ?? data["name"]?.string)
        data["bundleId"] = .text(app.bundleIdentifier)
        data["pid"] = .integer(Int64(app.processIdentifier))
        data["launchedAt"] = app.launchDate.map(JSON.date) ?? .null
        data["uptimeSeconds"] = app.launchDate.map { .integer(Int64(max(0, Date().timeIntervalSince($0)))) } ?? .null
        data["foreground"] = .boolean(NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier)
        data["active"] = .boolean(app.isActive)
        data["hidden"] = .boolean(app.isHidden)
        data["executablePath"] = .text(app.executableURL?.path(percentEncoded: false))
        return .object(data)
    }

    nonisolated private static var inventoryPaths: [String] {
        ["/Applications", "/System/Applications",
         FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path(percentEncoded: false)]
    }

    nonisolated private static func inventory() -> [String: JSON] {
        var found = [String: JSON]()
        for path in inventoryPaths {
            let directory = URL(fileURLWithPath: path, isDirectory: true)
            guard let entries = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey],
                                                               options: [.skipsPackageDescendants, .skipsHiddenFiles]) else { continue }
            for case let url as URL in entries {
                if entries.level > 3 { entries.skipDescendants(); continue }
                guard url.pathExtension == "app" else { continue }
                entries.skipDescendants()
                guard (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { continue }
                let item = app(url)
                if let id = item["applicationId"].string { found[id] = item }
                if found.count >= 1200 { return found }
            }
        }
        return found
    }

    nonisolated private static func external() -> [String: JSON] {
        guard let session = DASessionCreate(kCFAllocatorDefault) else { return [:] }
        let mounted = mounts()
        let media = IOServiceMatching(kIOMediaClass)
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, media, &iterator) == KERN_SUCCESS else { return [:] }
        defer { IOObjectRelease(iterator) }
        var results = [String: JSON]()
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            guard let bsd = IORegistryEntryCreateCFProperty(service, kIOBSDNameKey as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
                  let disk = DADiskCreateFromBSDName(kCFAllocatorDefault, session, bsd),
                  let value = DADiskCopyDescription(disk) as? [String: Any] else { continue }
            let hotPlug = (value[kDADiskDescriptionMediaRemovableKey as String] as? Bool) == true ||
                          (value[kDADiskDescriptionDeviceInternalKey as String] as? Bool) == false
            guard hotPlug else { continue }
            let mount = (value[kDADiskDescriptionVolumePathKey as String] as? URL)?.path(percentEncoded: false).trimmingSuffixSlash
            let capacity = (value[kDADiskDescriptionMediaSizeKey as String] as? NSNumber)?.int64Value
            results[bsd] = ["id": .string(bsd), "name": .text((value[kDADiskDescriptionVolumeNameKey as String]
                ?? value[kDADiskDescriptionMediaNameKey as String]) as? String), "capacityBytes": capacity.map(JSON.integer) ?? .null,
                "remainingBytes": mount.flatMap { mounted[$0]?["availableBytes"] } ?? .null,
                "fileSystem": .text(value[kDADiskDescriptionVolumeKindKey as String] as? String), "mountPath": .text(mount),
                "status": mount == nil ? "connected" : "mounted"]
        }
        return results
    }
}
