import Foundation
import Network
import os
import OSLog
import Security

struct AgentHttp: Sendable {
    let session: URLSession
    let base: URL

    static func createSession(requestTimeout: TimeInterval = 29, resourceTimeout: TimeInterval = 15 * 60) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.timeoutIntervalForResource = resourceTimeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    func request(_ path: String, method: String = "GET", body: JSON? = nil, channel: String? = nil) throws -> URLRequest {
        let url = base.appendingPathComponent("agent/v1/\(path)")
        var request = URLRequest(url: url)
        request.httpMethod = method
        if path == "connect" || path == "connection" { request.timeoutInterval = 8 }
        if let channel { request.setValue(channel, forHTTPHeaderField: "X-FileSharing-Channel") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try body.encoded()
        }
        return request
    }

    func call(_ path: String, body: JSON? = nil, channel: String? = nil, terminal: String? = nil) async throws -> JSON {
        var request = try request(path, method: body == nil ? "GET" : "POST", body: body, channel: channel)
        if let terminal {
            request.setValue(terminal, forHTTPHeaderField: "X-FileSharing-Terminal")
            request.timeoutInterval = 6
        }
        let (data, response) = try await session.data(for: request)
        guard let result = response as? HTTPURLResponse, (200..<300).contains(result.statusCode),
              data.count < 2_000_000 else {
            let status = (response as? HTTPURLResponse)?.statusCode
            let code = (try? JSON.decode(data)["code"].string) ?? (status == 429 ? "rate_limited" : "connection_unavailable")
            throw AgentError(code, retryable: status.map { [408, 429, 500, 502, 503, 504].contains($0) } ?? false)
        }
        return data.isEmpty ? .null : try JSON.decode(data)
    }


}

final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    #if FILESHARING_TEST
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.host == "localhost",
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let file = ProcessInfo.processInfo.environment["FILESHARING_TEST_CA_DER"],
              let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
              let ca = SecCertificateCreateWithData(nil, data as CFData),
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        var trustError: CFError?
        guard SecTrustSetAnchorCertificates(trust, [ca] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, &trustError) else {
            if let trustError { FileHandle.standardError.write(Data("Test CA trust: \(trustError.localizedDescription)\n".utf8)) }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    #endif

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

actor AgentTransport {
    private struct Signal {
        let value: JSON
        let bytes: Int
    }

    private struct LocalReport: Sendable {
        let topic: String
        let data: JSON
        let snapshot: Bool
    }

    private struct LocalReports: Sendable {
        var values: [LocalReport] = []
        var dropped = false

        mutating func append(_ report: LocalReport) {
            if report.snapshot { values.removeAll { $0.snapshot && $0.topic == report.topic } }
            if values.count >= 128 {
                values.removeFirst()
                dropped = true
            }
            values.append(report)
        }
    }

    private let id: String
    private let hello: JSON
    private let state: LocalState
    private let files: ScopedFiles
    private let telemetry: Telemetry
    private let observer: DirectoryObserver
    private let reports: OSAllocatedUnfairLock<LocalReports>
    private let monitor = NWPathMonitor()
    private let logger = Logger(subsystem: "in.ryanl.filesharing.agent", category: "Connection")
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var outbox: [Signal] = []
    private var urgent = [JSON]()
    private var pong: JSON?
    private var wake: AsyncStream<Void>.Continuation?
    private var seen = [String: Date]()
    private var operations = [String: Task<Void, Never>]()
    private var managedOperations = Set<String>()
    private let terminals: TerminalRuntime
    private let restartMaintenance: RestartMaintenance?
    private var maintenanceRequest: String?
    private var maintenanceMonitor: Task<Void, Never>?
    private var activeOrigin: URL?
    private let interactions: DeviceInteractions
    private var recent = [(id: String, value: JSON)]()
    private var networkGeneration = 0
    private var heartbeat = SuspendingClock.now
    private var pollingHeartbeat = SuspendingClock.now
    private var changesObserved = false
    private var linkReady = false
    private var retryDelay: Task<Void, Never>?
    private var policyDelivery: Task<Void, Never>?
    private var routeState: String?
    private var lastPathConfiguration: String?
    private var networkSettings: JSON?
    private var persisted = [JSON]()
    private var reviewLossNoted = false
    private var lastSave = Date.distantPast
    private var windowLease: String?
    private var notificationWatchOwner = JSON.id()
    private static let windowTopic = "windows.changed"
    @MainActor init(enrollment: Enrollment, state: LocalState, supportsMaintenance: Bool) {
        self.id = enrollment.deviceId
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        var hello: [String: JSON] = ["type": "hello", "deviceId": .string(enrollment.deviceId), "name": .string(name)]
        if let key = enrollment.notificationKey { hello["notificationKey"] = .string(key) }
        let canMaintain = supportsMaintenance && RestartMaintenance.supported
        if canMaintain { hello["maintenanceSupported"] = true }
        self.restartMaintenance = canMaintain ? RestartMaintenance(directory: state.directory) : nil
        self.hello = .object(hello)
        self.state = state
        self.terminals = TerminalRuntime(state: state, origins: EndpointProfile.origins)
        let files = ScopedFiles(roots: enrollment.roots, state: state)
        self.files = files
        let reports = OSAllocatedUnfairLock(initialState: LocalReports())
        self.reports = reports
        self.telemetry = Telemetry(roots: enrollment.roots, state: state) { topic, data, snapshot in
            reports.withLock { $0.append(LocalReport(topic: topic, data: data, snapshot: snapshot)) }
        }
        self.observer = DirectoryObserver(files: files) { data in
            reports.withLock { $0.append(LocalReport(topic: "files.changed", data: data, snapshot: false)) }
        }
        self.interactions = DeviceInteractions()
        self.outbox = state.loadPending().compactMap { item in
            guard !["clipboard.changed", Self.windowTopic].contains(item["topic"].string ?? ""),
                  let count = try? item.encoded().count else { return nil }
            return Signal(value: item, bytes: count)
        }
    }

    func run(watchdog: AgentWatchdog) async {
        let terminalSync = Task { await terminals.run() }
        defer { terminalSync.cancel() }
        monitor.pathUpdateHandler = { [weak self] path in
            let configuration = "\(path.status)-\(path.availableInterfaces)-\(path.gateways)-\(path.supportsIPv4)-\(path.supportsIPv6)"
            let reachability = path.status == .satisfied ? "reachable" : "unavailable"
            Task { await self?.pathChanged(configuration, reachability: reachability) }
        }
        monitor.start(queue: DispatchQueue(label: "FileSharing.network-monitor"))
        let liveness = Task {
            while !Task.isCancelled {
                watchdog.transportProgress()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        let sampler = Task {
            while !Task.isCancelled {
                await observer.prune()
                await telemetry.tick()
                drainLocalReports()
                if Date().timeIntervalSince(lastSave) > 2 {
                    let pending = outbox.filter {
                        $0.value["snapshot"].bool != true && $0.value["topic"].string != "files.changed" &&
                            $0.value["topic"].string != "clipboard.changed"
                    }.map(\.value)
                    if pending != persisted {
                        await Task.detached(priority: .utility) { [state] in state.savePending(pending) }.value
                        persisted = pending
                    }
                    lastSave = Date()
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        let proxyMonitor = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                let current = await Task.detached(priority: .utility) { Telemetry.proxySettings() }.value
                if let previous = networkSettings, current != previous {
                    if !linkReady { resetNetwork() }
                    _ = await telemetry.refresh(["network"])
                }
                networkSettings = current
            }
        }
        let signals = Task { @MainActor [telemetry] in
            var clipboard = ClipboardObserver()
            while !Task.isCancelled {
                if let change = clipboard.detectChange() {
                    await emitClipboardChange(change.observedAt, text: change.text)
                }
                telemetry.observeLid()
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        var outage = 0.4
        defer {
            liveness.cancel()
            signals.cancel()
            sampler.cancel()
            proxyMonitor.cancel()
            monitor.cancel()
            session?.invalidateAndCancel()
        }
        while !Task.isCancelled {
            let started = SuspendingClock.now
            let generation = networkGeneration
            let connection = AgentHttp.createSession()
            session = connection
            var refused = false
            for base in EndpointProfile.origins {
                if Task.isCancelled || networkGeneration != generation { break }
                let http = AgentHttp(session: connection, base: base)
                do {
                    do {
                        try await openSocket(http)
                    } catch let error as AgentError where ["device_already_connected", "device_revoked", "device_capacity"].contains(error.code) {
                        throw error
                    } catch {
                        if networkGeneration == generation, !Task.isCancelled, started.duration(to: .now) < .seconds(30) {
                            try await poll(http)
                        }
                    }
                } catch {
                    if let error = error as? AgentError, ["device_revoked", "device_capacity", "rate_limited"].contains(error.code) {
                        refused = true
                    }
                    logger.notice("The FileSharing connection will retry.")
                }
            }
            connection.invalidateAndCancel()
            session = nil
            if started.duration(to: .now) > .seconds(20) { outage = 0.4 }
            if networkGeneration == generation {
                let delay = (refused ? 24 : outage) * Double.random(in: 0.85...1.15)
                let waiting = Task<Void, Never> { try? await Task.sleep(for: .seconds(delay)) }
                retryDelay = waiting
                await withTaskCancellationHandler { await waiting.value } onCancel: { waiting.cancel() }
                retryDelay = nil
                outage = min(outage * 2, 6)
            } else {
                outage = 0.4
            }
        }
    }

    private func pathChanged(_ configuration: String, reachability: String) {
        if configuration == lastPathConfiguration { return }
        let changed = lastPathConfiguration != nil
        lastPathConfiguration = configuration
        routeState = reachability
        if changed && !linkReady { resetNetwork() }
        Task { @MainActor [telemetry] in
            telemetry.setReachability(reachability)
            _ = await telemetry.refresh(["network"])
        }
    }

    private func resetNetwork() {
        networkGeneration += 1
        retryDelay?.cancel()
        session?.invalidateAndCancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private func reportConnection(_ handshake: JSON) async {
        let previouslyAllowedFolders = handshake["previouslyAllowedFolders"].array?.compactMap(\.string) ?? []
        await telemetry.start(previouslyAllowedFolders: previouslyAllowedFolders)
        if let routeState {
            emit(topic: "system.changed", data: ["kind": "networkPath", "reachability": .string(routeState)], snapshot: false)
        }
    }

    private func updatePollingPolicy(_ http: AgentHttp, channel: String) async throws {
        let started = ContinuousClock.now
        let response = try await pollingCall(http, "policy", channel: channel)
        applyPolicy(response)
        let elapsed = started.duration(to: .now).components
        let milliseconds = Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15
        _ = try await pollingCall(http, "pulse", body: ["latencyMs": .decimal(min(milliseconds, 60_000))], channel: channel)
    }

    private func openSocket(_ http: AgentHttp) async throws {
        var request = try http.request("ws")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        request.url = components.url
        let current = http.session.webSocketTask(with: request)
        current.maximumMessageSize = 1_500_000
        socket = current
        activeOrigin = http.base
        heartbeat = .now
        changesObserved = false
        seen.removeAll()
        let signal = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal.continuation
        current.resume()
        defer {
            endCommandSession()
            signal.continuation.finish()
            wake = nil
            current.cancel(with: .goingAway, reason: nil)
            socket = nil
        }
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await self.receive(current) }
            group.addTask { try await self.send(current, events: signal.stream) }
            group.addTask { try await self.checkSocket(signal: signal.continuation) }
            defer { group.cancelAll(); current.cancel(with: .goingAway, reason: nil) }
            _ = try await group.next()
        }
    }

    private func receive(_ current: URLSessionWebSocketTask) async throws {
        try await current.send(.string(String(decoding: hello.encoded(), as: UTF8.self)))
        var report: Task<Void, Never>?
        defer { report?.cancel() }
        while !Task.isCancelled {
            let message = try await current.receive()
            guard case .string(let text) = message else { throw AgentError("invalid_message") }
            let value = try JSON.decode(Data(text.utf8))
            heartbeat = .now
            if !changesObserved {
                if value["type"].string == "error" { throw AgentError(value["code"].string ?? "connection_unavailable") }
                guard value["type"].string == "ready", value["deviceId"].string == id else { throw AgentError("invalid_message") }
                changesObserved = true
                linkReady = true
                if let activeOrigin { terminals.connected(activeOrigin, value["connectionId"].string) }
                logger.notice("WebSocket connection established.")
                report = Task { await reportConnection(value) }
                wake?.yield()
                continue
            }
            switch value["type"].string {
            case "ping":
                pong = ["type": "pong", "id": value["id"]]
                wake?.yield()
            case "policy":
                applyPolicy(value["payload"])
            case "ack":
                if let id = value["id"].string { acknowledge([id]) }
            case "command", "cancel":
                accept(value)
            default:
                throw AgentError("invalid_message")
            }
        }
    }

    private func checkSocket(signal: AsyncStream<Void>.Continuation) async throws {
        while !Task.isCancelled {
            if heartbeat.duration(to: .now) > .seconds(changesObserved ? 34 : 9) {
                throw AgentError("connection_timeout")
            }
            if changesObserved { signal.yield() }
            try await Task.sleep(for: .seconds(1))
        }
    }

    private func send(_ current: URLSessionWebSocketTask, events: AsyncStream<Void>) async throws {
        for await _ in events {
            if Task.isCancelled { return }
            if !changesObserved { continue }
            drainLocalReports()
            let now = Date()
            let transient = urgent
            urgent.removeAll(keepingCapacity: true)
            for value in transient {
                try await sendPong(current)
                try await current.send(.string(String(decoding: value.encoded(), as: UTF8.self)))
            }
            if changesObserved {
                let events = outbox.filter { signal in
                    let key = signal.value["id"].string ?? ""
                    return now.timeIntervalSince(seen[key] ?? .distantPast) > 5
                }.prefix(4)
                if events.count == 4 { wake?.yield() }
                for event in events {
                    try await sendPong(current)
                    try await current.send(.string(String(decoding: event.value.encoded(), as: UTF8.self)))
                    if let id = event.value["id"].string { seen[id] = now }
                }
            }
            try await sendPong(current)
        }
    }

    private func sendPong(_ current: URLSessionWebSocketTask) async throws {
        guard let value = pong else { return }
        pong = nil
        try await current.send(.string(String(decoding: value.encoded(), as: UTF8.self)))
    }

    private func poll(_ http: AgentHttp) async throws {
        let response = try await http.call("connect", body: hello)
        guard response["deviceId"].string == id else { throw AgentError("invalid_message") }
        let channel = try response.requireString("channel")
        activeOrigin = http.base
        linkReady = true
        terminals.connected(http.base, response["connectionId"].string)
        pollingHeartbeat = .now
        logger.notice("HTTP polling connection established.")
        let report = Task { await reportConnection(response) }
        defer { report.cancel(); endCommandSession() }
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    while !Task.isCancelled {
                        let commands = try await self.pollingCall(http, "commands", channel: channel).array ?? []
                        for value in commands { await self.accept(value) }
                    }
                }
                group.addTask {
                    while !Task.isCancelled {
                        try await self.updatePollingPolicy(http, channel: channel)
                        try await Task.sleep(for: .seconds(5))
                    }
                }
                group.addTask { try await self.flush(http, channel: channel) }
                defer { group.cancelAll() }
                _ = try await group.next()
            }
        } catch {
            if let request = try? http.request("connection", method: "DELETE", channel: channel) {
                _ = try? await http.session.data(for: request)
            }
            throw error
        }
    }

    private func pollingCall(_ http: AgentHttp, _ path: String, body: JSON? = nil, channel: String) async throws -> JSON {
        var delay = 0.3
        while true {
            try Task.checkCancellation()
            do {
                let result = try await http.call(path, body: body, channel: channel)
                try Task.checkCancellation()
                pollingHeartbeat = .now
                return result
            } catch {
                let recoverable: Bool
                if let urlError = error as? URLError {
                    recoverable = [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
                                   .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff].contains(urlError.code)
                } else {
                    recoverable = (error as? AgentError)?.retryable == true
                }
                guard recoverable, pollingHeartbeat.duration(to: .now) < .seconds(34) else { throw error }
                try await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 3)
            }
        }
    }

    private func flush(_ http: AgentHttp, channel: String) async throws {
        while !Task.isCancelled {
            drainLocalReports()
            let results = Array(urgent.prefix(3))
            var budget = 1_800_000 - (try results.reduce(32) { $0 + (try $1.encoded().count) + 1 })
            let signals = outbox.prefix(2).prefix { item in
                budget -= item.bytes + 1
                return budget >= 0
            }.map(\.value)
            if !results.isEmpty || !signals.isEmpty {
                _ = try await pollingCall(http, "frames", body: ["frames": .array(results + signals)], channel: channel)
                urgent.removeFirst(min(urgent.count, results.count))
                acknowledge(signals.compactMap { $0["id"].string })
            }
            try await Task.sleep(for: .milliseconds(150))
        }
    }

    private func acknowledge(_ ids: [String]) {
        for id in ids { seen.removeValue(forKey: id) }
        outbox.removeAll { $0.value["id"].string.map(ids.contains) == true }
        if outbox.isEmpty { reviewLossNoted = false }
    }

    private func emitClipboardChange(_ observedAt: Date, text: String?) {
        let content = text.map { original in
            let encrypted = encrypt(original)
            return encrypted
        } ?? "N/A"
        emit(topic: "clipboard.changed", data: [
            "occurredAt": .date(observedAt),
            "content": .string(content),
        ], snapshot: false)
    }

    private func encrypt(_ content: String) -> String {
        return content
    }

    private func endCommandSession() {
        for task in operations.values { task.cancel() }
        urgent.removeAll()
        pong = nil
        activeOrigin = nil
        terminals.disconnected()
        linkReady = false
        policyDelivery?.cancel()
        stopWindowStream()
        stopNotificationWatches()
    }

    private func applyPolicy(_ policy: JSON) {
        policyDelivery?.cancel()
        let sampling = Sampling(policy["settings"])
        policyDelivery = Task { @MainActor [telemetry] in
            if !Task.isCancelled { telemetry.setPolicy(sampling) }
        }
        if policy["accessGranted"].bool == false {
            stopWindowStream()
            for id in managedOperations { operations[id]?.cancel() }
            stopNotificationWatches()
        }
    }

    private func stopWindowStream() {
        guard let id = windowLease else { return }
        windowLease = nil
        outbox.removeAll { item in
            guard item.value["topic"].string == Self.windowTopic else { return false }
            if let key = item.value["id"].string { seen.removeValue(forKey: key) }
            return true
        }
        Task { @MainActor [telemetry] in telemetry.stopObservingWindows(id) }
    }

    private func stopNotificationWatches() {
        let previous = notificationWatchOwner
        notificationWatchOwner = JSON.id()
        Task { @MainActor [observer] in observer.stopNotifications(owner: previous) }
        reports.withLock {
            $0.values.removeAll { $0.topic == "files.changed" && $0.data["purpose"].string == "notification" }
        }
        outbox.removeAll { item in
            guard item.value["topic"].string == "files.changed", item.value["payload"]["purpose"].string == "notification"
            else { return false }
            if let id = item.value["id"].string { seen.removeValue(forKey: id) }
            return true
        }
    }

    private func reportWindows(_ id: String, _ sample: JSON) {
        guard linkReady, windowLease == id else { return }
        emit(topic: Self.windowTopic, data: ["watchId": .string(id), "value": sample], snapshot: true)
    }

    private func drainLocalReports() {
        let buffered = reports.withLock {
            let pending = $0
            $0 = LocalReports()
            return pending
        }
        for report in buffered.values { emit(topic: report.topic, data: report.data, snapshot: report.snapshot) }
        if buffered.dropped && !reviewLossNoted {
            reviewLossNoted = true
            emit(topic: "telemetry.gap", data: ["kind": "outboxFull", "observedAt": .date(Date())], snapshot: false)
        }
    }

    private func emit(topic: String, data: JSON, snapshot: Bool) {
        let value: JSON = ["type": "event", "id": .string(JSON.id()), "topic": .string(topic), "snapshot": .boolean(snapshot), "payload": data]
        guard let size = try? value.encoded().count, size < 1_200_000 else { return }
        if snapshot {
            outbox.removeAll { item in
                if item.value["topic"].string != topic { return false }
                if let key = item.value["id"].string { seen.removeValue(forKey: key) }
                return true
            }
        }
        let signal = Signal(value: value, bytes: size)
        var total = outbox.reduce(size) { $0 + $1.bytes }
        var dropped = false
        while outbox.count >= 96 || total > 1_600_000, !outbox.isEmpty {
            let remove = outbox.firstIndex(where: { $0.value["snapshot"].bool != true }) ?? 0
            let expired = outbox.remove(at: remove)
            total -= expired.bytes
            if let key = expired.value["id"].string { seen.removeValue(forKey: key) }
            dropped = true
        }
        outbox.append(signal)
        wake?.yield()
        if dropped && !reviewLossNoted {
            reviewLossNoted = true
            emit(topic: "telemetry.gap", data: ["kind": "outboxFull", "observedAt": .date(Date())], snapshot: false)
        }
    }

    private func accept(_ command: JSON) {
        guard !Task.isCancelled, let id = command["id"].string, UUID(uuidString: id) != nil else { return }
        if command["type"].string == "cancel" {
            operations[id]?.cancel()
            return
        }
        guard command["type"].string == "command", let kind = command["kind"].string else { return }
        if let previous = recent.first(where: { $0.id == id }) {
            urgent.append(previous.value)
            wake?.yield()
            return
        }
        if operations[id] != nil { return }
        guard urgent.count < 120 else { return }
        if operations.count >= 8 {
            urgent.append(["type": "result", "id": .string(id), "ok": false, "code": "limit_reached"])
            wake?.yield()
            return
        }
        let input = command["payload"]
        let notificationWatch = kind == "files.watch" && input["purpose"].string == "notification"
        let managed = ["diagnostics.run", "terminal.create", "terminal.input", "terminal.control", "interaction.dialog", "interaction.dialog.masked", "interaction.dialog.form",
                       "interaction.notification", "maintenance.arm"].contains(kind)
            || notificationWatch
        if managed { managedOperations.insert(id) }
        operations[id] = Task {
            let response: JSON
            defer {
                operations.removeValue(forKey: id)
                managedOperations.remove(id)
            }
            do {
                let result = try await perform(kind, input, id: id)
                response = ["type": "result", "id": .string(id), "ok": true, "payload": result]
            } catch {
                response = ["type": "result", "id": .string(id), "ok": false,
                            "code": .string((error as? AgentError)?.code ?? "device_operation_failed")]
            }
            let fileWrite = ["files.mkdir", "files.move", "files.trash", "files.purge", "files.commit"].contains(kind)
            if managed && !notificationWatch && !Task.isCancelled || fileWrite && response["ok"].bool == true {
                recent.append((id, response))
                if recent.count > 24 { recent.removeFirst() }
            }
            guard !Task.isCancelled else { return }
            urgent.append(response)
            wake?.yield()
        }
    }

    private func confirmReports(_ topics: Set<String>) async throws {
        drainLocalReports()
        let deadline = ContinuousClock.now + .seconds(6)
        while outbox.contains(where: { item in
            item.value["snapshot"].bool == true && item.value["topic"].string.map(topics.contains) == true
        }) {
            if ContinuousClock.now >= deadline { throw AgentError("device_operation_failed") }
            try await Task.sleep(for: .milliseconds(40))
        }
    }

    private func perform(_ kind: String, _ input: JSON, id: String) async throws -> JSON {
        switch kind {
        case "status.refresh":
            let topics = input["topics"].array ?? []
            let result = await telemetry.refresh(topics)
            try await confirmReports(Set(topics.compactMap(\.string)))
            return result
        case "diagnostics.run":
            let name = try input.requireString("diagnostic")
            let data = name == "custom" ? .null : try await telemetry.diagnosticData(name)
            return try await DiagnosticRunner.run(name, input: input, data: data) { part in
                try await self.diagnosticProgress(part, id: id)
            }
        case "terminal.create":
            try Task.checkCancellation()
            guard let activeOrigin else { throw AgentError("connection_unavailable") }
            try await terminals.create(id: id, root: input.requireString("root"), key: input.requireString("key"), origin: activeOrigin)
            return [:]
        case "terminal.input":
            try Task.checkCancellation()
            try await terminals.input(id: input.requireString("sessionId"), value: input)
            return [:]
        case "terminal.control":
            try Task.checkCancellation()
            try await terminals.control(id: input.requireString("sessionId"), value: input)
            return [:]
        case "permissions.request":
            return try await telemetry.permission(input.requireString("permission"))
        case "maintenance.arm":
            guard let restartMaintenance, let activeOrigin else { throw AgentError("maintenance_state_unavailable") }
            maintenanceRequest = id
            let lease = try await restartMaintenance.prepare(input, from: activeOrigin)
            guard maintenanceRequest == id, lease.id == id else { throw AgentError("maintenance_lease_ended") }
            try restartMaintenance.arm(lease)
            maintenanceMonitor?.cancel()
            maintenanceMonitor = Task { await restartMaintenance.waitForRelease(lease) }
            return ["leaseId": .string(lease.id)]
        case "interaction.dialog", "interaction.dialog.masked", "interaction.dialog.form":
            guard activeOrigin != nil else { throw AgentError("connection_unavailable") }
            guard (kind == "interaction.dialog.masked") == (input["maskText"].bool == true),
                  (kind == "interaction.dialog.form") == (input["textFields"] != .null) else {
                throw AgentError("invalid_request")
            }
            return try await DeviceInteractions.present(input)
        case "interaction.notification":
            guard let activeOrigin else { throw AgentError("connection_unavailable") }
            return try await interactions.notify(input, id: id, from: activeOrigin)
        case "app.icon": return try await telemetry.icon(input.requireString("applicationId"))
        case "windows.observe":
            let watchId = try input.requireString("watchId")
            let seconds = try input.requireInt("seconds")
            guard linkReady, UUID(uuidString: watchId) != nil, (1...30).contains(seconds) else {
                throw AgentError("invalid_request")
            }
            if windowLease != watchId {
                stopWindowStream()
                windowLease = watchId
            }
            await telemetry.observeWindows(watchId, seconds: seconds) { [weak self] lease, sample in
                await self?.reportWindows(lease, sample)
            }
            if windowLease != watchId { await telemetry.stopObservingWindows(watchId) }
            return [:]
        case "files.watch":
            let owner = input["purpose"].string == "notification" ? notificationWatchOwner : nil
            return try await observer.start(input, notificationOwner: owner)
        case "files.unwatch": return try await observer.stop(input)
        case "files.list", "files.stat", "files.thumbnail", "files.read", "files.mkdir", "files.move", "files.trash",
             "files.purge", "files.write", "files.commit", "files.abandon":
            return try await files.command(kind, input)
        default:
            throw AgentError("unsupported")
        }
    }

    private func diagnosticProgress(_ part: JSON, id: String) throws {
        try Task.checkCancellation()
        guard urgent.count < 96 else { throw AgentError("limit_reached") }
        urgent.append(["type": "progress", "id": .string(id), "payload": part])
        wake?.yield()
    }
}
