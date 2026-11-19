import Foundation
import Network
import Security

struct AgentHttp {
    let session: URLSession
    let base: URL

    static func createSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 29
        configuration.timeoutIntervalForResource = 15 * 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    func request(_ path: String, method: String = "GET", body: JSON? = nil, channel: String? = nil) throws -> URLRequest {
        let url = base.appendingPathComponent("agent/v1/\(path)")
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let channel { request.setValue(channel, forHTTPHeaderField: "X-FileSharing-Channel") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try body.encoded()
        }
        return request
    }

    func call(_ path: String, body: JSON? = nil, channel: String? = nil) async throws -> JSON {
        let request = try request(path, method: body == nil ? "GET" : "POST", body: body, channel: channel)
        let (data, response) = try await session.data(for: request)
        guard let result = response as? HTTPURLResponse, (200..<300).contains(result.statusCode),
              data.count < 2_000_000 else {
            let code = (try? JSON.decode(data)["code"].string) ?? "connection_unavailable"
            throw AgentError(code)
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

@MainActor
final class AgentTransport {
    private struct Signal {
        let value: JSON
        let bytes: Int
    }

    private let id: String
    private let hello: JSON
    private let state: LocalState
    private let files: ScopedFiles
    private let roots: [LocalRoot]
    private let monitor = NWPathMonitor()
    private let logger = Logger()
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var outbox: [Signal] = []
    private var urgent = [JSON]()
    private var wake: AsyncStream<Void>.Continuation?
    private var seen = [String: Date]()
    private var operations = Set<String>()
    private var recent = [(id: String, value: JSON)]()
    private var networkGeneration = 0
    private var heartbeat = Date()
    private var changesObserved = false
    private var routeState: String?
    private var lastPathConfiguration: String?
    private var networkSettings = Telemetry.network()
    private var persisted = [JSON]()
    private var reviewLossNoted = false
    private var lastSave = Date.distantPast

    private lazy var telemetry = Telemetry(roots: roots, state: state) { [weak self] topic, payload, snapshot in
        self?.emit(topic: topic, data: payload, snapshot: snapshot)
    }
    private lazy var observer = DirectoryObserver(files: files) { [weak self] value in
        self?.emit(topic: "files.changed", data: value, snapshot: false)
    }

    init(enrollment: Enrollment, state: LocalState) {
        self.id = enrollment.deviceId
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        self.hello = ["type": "hello", "deviceId": .string(enrollment.deviceId), "name": .string(name)]
        self.state = state
        self.roots = enrollment.roots
        self.files = ScopedFiles(roots: enrollment.roots)
        self.outbox = state.loadPending().compactMap { item in
            guard let count = try? item.encoded().count else { return nil }
            return Signal(value: item, bytes: count)
        }
    }

    func run() async {
        monitor.pathUpdateHandler = { [weak self] path in
            let configuration = "\(path.status)-\(path.availableInterfaces)-\(path.gateways)-\(path.supportsIPv4)-\(path.supportsIPv6)"
            let reachability = path.status == .satisfied ? "reachable" : "unavailable"
            Task { @MainActor in self?.pathChanged(configuration, reachability: reachability) }
        }
        monitor.start(queue: DispatchQueue(label: "FileSharing.network-monitor"))
        let sampler = Task {
            while !Task.isCancelled {
                observer.prune()
                await telemetry.tick()
                if Date().timeIntervalSince(lastSave) > 2 {
                    let pending = outbox.filter { $0.value["snapshot"].bool != true && $0.value["topic"].string != "files.changed" }.map(\.value)
                    if pending != persisted {
                        state.savePending(pending)
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
                let current = Telemetry.network()
                if current != networkSettings {
                    networkSettings = current
                    resetNetwork()
                    _ = await telemetry.refresh(["network"])
                }
            }
        }
        var outage = 0.5
        defer { sampler.cancel(); proxyMonitor.cancel(); monitor.cancel(); session?.invalidateAndCancel() }
        while !Task.isCancelled {
            let started = Date()
            let generation = networkGeneration
            let connection = AgentHttp.createSession()
            session = connection
            for base in EndpointProfile.origins {
                if Task.isCancelled || networkGeneration != generation { break }
                let http = AgentHttp(session: connection, base: base)
                do {
                    do {
                        try await openSocket(http)
                    } catch let error as AgentError where ["device_already_connected", "device_revoked", "device_capacity"].contains(error.code) {
                        throw error
                    } catch {
                        if networkGeneration == generation, !Task.isCancelled, Date().timeIntervalSince(started) < 540 {
                            try await poll(http)
                        }
                    }
                } catch {
                    logger.notice("The FileSharing connection will retry.")
                }
            }
            connection.invalidateAndCancel()
            session = nil
            if Date().timeIntervalSince(started) > 20 { outage = 0.5 }
            if networkGeneration == generation {
                try? await Task.sleep(for: .seconds(outage * Double.random(in: 0.75...1.25)))
                outage = min(outage * 2, 24)
            }
        }
    }

    private func pathChanged(_ configuration: String, reachability: String) {
        if configuration == lastPathConfiguration { return }
        let changed = lastPathConfiguration != nil
        lastPathConfiguration = configuration
        routeState = reachability
        if changed { resetNetwork() }
        Task { _ = await telemetry.refresh(["network"]) }
    }

    private func resetNetwork() {
        networkGeneration += 1
        session?.invalidateAndCancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private func reportConnection() async {
        await telemetry.start()
        if let routeState {
            emit(topic: "system.changed", data: ["kind": "networkPath", "reachability": .string(routeState)], snapshot: false)
        }
    }

    private func updatePollingPolicy(_ http: AgentHttp, channel: String) async {
        let started = ContinuousClock.now
        if let response = try? await http.call("policy", channel: channel), !Task.isCancelled {
            telemetry.setPolicy(Sampling(response["settings"]))
            let elapsed = started.duration(to: .now).components
            let milliseconds = Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15
            _ = try? await http.call("pulse", body: ["latencyMs": .decimal(milliseconds)], channel: channel)
        }
    }

    private func openSocket(_ http: AgentHttp) async throws {
        var request = try http.request("ws")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        request.url = components.url
        let current = http.session.webSocketTask(with: request)
        current.maximumMessageSize = 1_500_000
        socket = current
        heartbeat = Date()
        changesObserved = false
        seen.removeAll()
        let signal = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal.continuation
        current.resume()
        defer {
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
            heartbeat = Date()
            if !changesObserved {
                if value["type"].string == "error" { throw AgentError(value["code"].string ?? "connection_unavailable") }
                guard value["type"].string == "ready", value["deviceId"].string == id else { throw AgentError("invalid_message") }
                changesObserved = true
                report = Task { await reportConnection() }
                wake?.yield()
                continue
            }
            switch value["type"].string {
            case "ping":
                urgent.append(["type": "pong", "id": value["id"]])
                wake?.yield()
            case "policy":
                telemetry.setPolicy(Sampling(value["payload"]["settings"]))
            case "ack":
                if let id = value["id"].string { acknowledge([id]) }
            case "command":
                accept(value)
            default:
                throw AgentError("invalid_message")
            }
        }
    }

    private func checkSocket(signal: AsyncStream<Void>.Continuation) async throws {
        while !Task.isCancelled {
            if Date().timeIntervalSince(heartbeat) > (changesObserved ? 32 : 9) {
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
            let now = Date()
            let transient = urgent
            urgent.removeAll(keepingCapacity: true)
            do {
                for value in transient {
                    try await current.send(.string(String(decoding: value.encoded(), as: UTF8.self)))
                }
            } catch {
                urgent.insert(contentsOf: transient.filter { $0["type"].string == "result" }, at: 0)
                throw error
            }
            if changesObserved {
                let events = outbox.filter { signal in
                    let key = signal.value["id"].string ?? ""
                    return now.timeIntervalSince(seen[key] ?? .distantPast) > 5
                }.prefix(4)
                if events.count == 4 { wake?.yield() }
                for event in events {
                    try await current.send(.string(String(decoding: event.value.encoded(), as: UTF8.self)))
                    if let id = event.value["id"].string { seen[id] = now }
                }
            }
        }
    }

    private func poll(_ http: AgentHttp) async throws {
        urgent.removeAll { $0["type"].string == "pong" }
        let response = try await http.call("connect", body: hello)
        guard response["deviceId"].string == id else { throw AgentError("invalid_message") }
        let channel = try response.requireString("channel")
        let refresh = Task {
            await updatePollingPolicy(http, channel: channel)
            await reportConnection()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if !Task.isCancelled { await updatePollingPolicy(http, channel: channel) }
            }
        }
        defer { refresh.cancel() }
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    while !Task.isCancelled {
                        let commands = try await http.call("commands", channel: channel).array ?? []
                        for value in commands { await self.accept(value) }
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

    private func flush(_ http: AgentHttp, channel: String) async throws {
        while !Task.isCancelled {
            let results = Array(urgent.prefix(3))
            let signals = outbox.prefix(2).map(\.value)
            if !results.isEmpty || !signals.isEmpty {
                _ = try await http.call("frames", body: ["frames": .array(results + signals)], channel: channel)
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
        guard command["type"].string == "command", let id = command["id"].string, UUID(uuidString: id) != nil,
              let kind = command["kind"].string else { return }
        if let previous = recent.first(where: { $0.id == id }) {
            urgent.append(previous.value)
            wake?.yield()
            return
        }
        if operations.contains(id) { return }
        if operations.count >= 8 {
            urgent.append(["type": "result", "id": .string(id), "ok": false, "code": "limit_reached"])
            wake?.yield()
            return
        }
        operations.insert(id)
        let input = command["payload"]
        Task {
            let response: JSON
            do {
                let result = try await perform(kind, input)
                response = ["type": "result", "id": .string(id), "ok": true, "payload": result]
            } catch {
                response = ["type": "result", "id": .string(id), "ok": false,
                            "code": .string((error as? AgentError)?.code ?? "device_operation_failed")]
            }
            operations.remove(id)
            urgent.append(response)
            wake?.yield()
            if ["files.mkdir", "files.move", "files.trash", "files.purge", "files.commit"].contains(kind), response["ok"].bool == true {
                recent.append((id, response))
                if recent.count > 24 { recent.removeFirst() }
            }
            if urgent.count > 30 { urgent.removeFirst(urgent.count - 30) }
        }
    }

    private func confirmReports(_ topics: Set<String>) async throws {
        let deadline = ContinuousClock.now + .seconds(6)
        while outbox.contains(where: { item in
            item.value["snapshot"].bool == true && item.value["topic"].string.map(topics.contains) == true
        }) {
            if ContinuousClock.now >= deadline { throw AgentError("device_operation_failed") }
            try await Task.sleep(for: .milliseconds(40))
        }
    }

    private func perform(_ kind: String, _ input: JSON) async throws -> JSON {
        switch kind {
        case "status.refresh":
            let topics = input["topics"].array ?? []
            let result = await telemetry.refresh(topics)
            try await confirmReports(Set(topics.compactMap(\.string)))
            return result
        case "diagnostics.run":
            return try telemetry.diagnostic(input.requireString("diagnostic"))
        case "permissions.request":
            let result = try await telemetry.permission(input.requireString("permission"))
            try await confirmReports(["permissions"])
            return result
        case "app.icon": return try telemetry.icon(input.requireString("applicationId"))
        case "files.watch": return try await observer.start(input)
        case "files.unwatch": return try observer.stop(input)
        case "files.list", "files.stat", "files.thumbnail", "files.read", "files.mkdir", "files.move", "files.trash",
             "files.purge", "files.write", "files.commit", "files.abandon":
            return try await files.command(kind, input)
        default:
            throw AgentError("unsupported")
        }
    }
}

private struct Logger {
    func notice(_ line: String) {
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}
