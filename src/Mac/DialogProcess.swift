import Darwin
import Foundation

enum DialogProcess {
    private static let queue = DispatchQueue(label: "FileSharing.dialog-helper", qos: .userInitiated)
    private static let maximum = 8_192

    static func run(_ executable: URL?, input: JSON) async throws -> JSON {
        guard let executable else { throw AgentError("unsupported") }
        guard let seconds = input["timeoutSeconds"].int, (10...120).contains(seconds) else {
            throw AgentError("invalid_request")
        }
        let request = try input.encoded()
        guard request.count <= maximum else { throw AgentError("invalid_request") }
        let replies = AsyncThrowingStream<JSON, Error> { stream in
            let finished = DispatchSemaphore(value: 0)
            stream.onTermination = { termination in
                if case .cancelled = termination { finished.signal() }
            }
            queue.async {
                defer { stream.finish() }
                guard finished.wait(timeout: .now()) == .timedOut else { return }
                do {
                    stream.yield(try exchange(executable, request: request, seconds: Int(seconds), finished: finished))
                } catch {
                    stream.finish(throwing: (error as? AgentError) ?? AgentError("dialog_presentation_failed"))
                }
            }
        }
        for try await reply in replies {
            try Task.checkCancellation()
            return reply
        }
        try Task.checkCancellation()
        throw AgentError("dialog_presentation_failed")
    }

    private static func exchange(_ executable: URL, request: Data, seconds: Int, finished: DispatchSemaphore) throws -> JSON {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let sender = input.fileHandleForWriting
        let receiver = output.fileHandleForReading
        guard fcntl(sender.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw AgentError("dialog_presentation_failed")
        }
        process.executableURL = executable
        process.arguments = ["dialog-helper"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in finished.signal() }
        let deadline = DispatchTime.now() + .seconds(seconds + 3)
        try process.run()
        defer {
            if process.isRunning {
                process.terminate()
                if finished.wait(timeout: .now() + .milliseconds(750)) == .timedOut, process.isRunning {
                    _ = kill(process.processIdentifier, SIGKILL)
                }
            }
            process.waitUntilExit()
        }
        try sender.write(contentsOf: request)
        try sender.close()
        if finished.wait(timeout: deadline) == .timedOut {
            return outcome("expired")
        }
        guard !process.isRunning else { throw CancellationError() }
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let bytes = try receiver.read(upToCount: maximum + 1), bytes.count <= maximum else {
            throw AgentError("dialog_presentation_failed")
        }
        let reply = try JSON.decode(bytes)
        if let code = reply["code"].string { throw AgentError(code) }
        guard reply["payload"] != .null else { throw AgentError("dialog_presentation_failed") }
        return reply["payload"]
    }

    static func outcome(_ status: String, choice: String? = nil, text: String? = nil, authenticated: Bool = false) -> JSON {
        var result: [String: JSON] = ["outcome": .string(status), "choiceId": .text(choice),
                                      "text": .text(text), "respondedAt": .date(Date())]
        if authenticated { result["locallyAuthenticated"] = true }
        return .object(result)
    }
}
