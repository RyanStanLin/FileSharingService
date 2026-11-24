import Foundation
import Network

enum SshDeviceRelay {
    private static let chunkSize = 16 * 1024

    static func run(http: AgentHttp, id: String, channel: String, ready: @Sendable () async throws -> Void) async throws {
        guard channel.utf8.count == 43 else { throw AgentError("invalid_request") }
        let socket = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        try await withTaskCancellationHandler {
            defer { socket.cancel() }
            try await connect(socket)
            try await ready()
            let route = "ssh/\(id)"
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    try await download(socket, http: http, route: route, channel: channel)
                }
                group.addTask {
                    try await upload(socket, http: http, route: route, channel: channel)
                }
                defer {
                    group.cancelAll()
                    socket.cancel()
                }
                try await group.next()
            }
        } onCancel: {
            socket.cancel()
        }
    }

    private static var port: NWEndpoint.Port {
        #if FILESHARING_TEST
        if let value = ProcessInfo.processInfo.environment["FILESHARING_TEST_SSH_PORT"],
           let number = UInt16(value), number > 0, let port = NWEndpoint.Port(rawValue: number) {
            return port
        }
        #endif
        return 22
    }

    private static func connect(_ socket: NWConnection) async throws {
        let states = AsyncStream<NWConnection.State>.makeStream(bufferingPolicy: .bufferingNewest(4))
        socket.stateUpdateHandler = { state in states.continuation.yield(state) }
        socket.start(queue: DispatchQueue.global(qos: .utility))
        defer {
            states.continuation.finish()
            socket.stateUpdateHandler = nil
        }
        for await state in states.stream {
            try Task.checkCancellation()
            switch state {
            case .ready: return
            case .waiting, .failed: throw AgentError("ssh_remote_login_unavailable")
            case .cancelled: throw CancellationError()
            default: continue
            }
        }
        throw CancellationError()
    }

    private static func download(_ socket: NWConnection, http: AgentHttp, route: String, channel: String) async throws {
        var cursor: Int64 = 0
        while !Task.isCancelled {
            let frame = try await exchange(http, "\(route)/input/\(cursor)", channel: channel)
            if frame == .null { continue }
            guard frame["index"].int == cursor + 1 else { throw AgentError("invalid_ssh_cursor") }
            if frame["data"] == .null { return }
            guard let encoded = frame["data"].string, encoded.utf8.count <= 21_848,
                  let bytes = Data(base64Encoded: encoded), (1...chunkSize).contains(bytes.count) else {
                throw AgentError("invalid_ssh_chunk")
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                socket.send(content: bytes, completion: .contentProcessed { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                })
            }
            cursor += 1
        }
    }

    private static func upload(_ socket: NWConnection, http: AgentHttp, route: String, channel: String) async throws {
        var index: Int64 = 0
        while !Task.isCancelled {
            let bytes: Data? = try await withCheckedThrowingContinuation { continuation in
                socket.receive(minimumIncompleteLength: 1, maximumLength: chunkSize) { bytes, _, _, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: bytes) }
                }
            }
            index += 1
            let body: JSON = ["index": .integer(index), "data": .text(bytes?.base64EncodedString())]
            _ = try await exchange(http, "\(route)/output", body: body, channel: channel)
            if bytes == nil { return }
        }
    }

    private static func exchange(_ http: AgentHttp, _ path: String, body: JSON? = nil, channel: String) async throws -> JSON {
        for delay in [150, 500, 1200] {
            try Task.checkCancellation()
            do { return try await http.call(path, body: body, channel: channel) }
            catch let error as AgentError where error.retryable { }
            catch let error as URLError where [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                                               .cannotConnectToHost].contains(error.code) { }
            try await Task.sleep(for: .milliseconds(delay))
        }
        return try await http.call(path, body: body, channel: channel)
    }
}
