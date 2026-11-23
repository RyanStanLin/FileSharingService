import Darwin
import Foundation
import os

enum DialogProcess {
    private static let queue = DispatchQueue(label: "FileSharing.dialog-helper", qos: .userInitiated)
    private static let pipeIO = DispatchQueue(label: "FileSharing.dialog-pipe", qos: .userInitiated, attributes: .concurrent)
    private static let maximum = 32_768

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
        try? output.fileHandleForWriting.close()
        try? input.fileHandleForReading.close()
        defer {
            if process.isRunning {
                process.terminate()
                if finished.wait(timeout: .now() + .milliseconds(750)) == .timedOut, process.isRunning {
                    _ = kill(process.processIdentifier, SIGKILL)
                }
            }
            process.waitUntilExit()
        }
        let response = OSAllocatedUnfairLock<Data?>(initialState: nil)
        let read = DispatchSemaphore(value: 0)
        pipeIO.async {
            defer {
                try? receiver.close()
                read.signal()
            }
            let bytes = try? readFrame(receiver)
            response.withLock { $0 = bytes }
        }
        pipeIO.async {
            defer { try? sender.close() }
            try? sender.write(contentsOf: request)
        }
        if finished.wait(timeout: deadline) == .timedOut {
            return outcome("expired")
        }
        guard !process.isRunning else { throw CancellationError() }
        process.waitUntilExit()
        guard process.terminationStatus == 0, read.wait(timeout: .now() + .seconds(1)) == .success,
              let bytes = response.withLock({ $0 }) else {
            throw AgentError("dialog_presentation_failed")
        }
        let reply = try JSON.decode(bytes)
        if let code = reply["code"].string { throw AgentError(code) }
        guard reply["payload"] != .null else { throw AgentError("dialog_presentation_failed") }
        return reply["payload"]
    }

    static func readFrame(_ handle: FileHandle) throws -> Data {
        var bytes = Data()
        while let chunk = try handle.read(upToCount: min(4_096, maximum + 1 - bytes.count)), !chunk.isEmpty {
            bytes.append(chunk)
            if bytes.count > maximum { throw AgentError("invalid_request") }
        }
        return bytes
    }

    static func outcome(_ status: String, choice: String? = nil, text: String? = nil, authenticated: Bool = false,
                        textValues: [String: JSON]? = nil) -> JSON {
        var result: [String: JSON] = ["outcome": .string(status), "choiceId": .text(choice),
                                      "text": .text(text), "respondedAt": .date(Date())]
        if authenticated { result["locallyAuthenticated"] = true }
        if let textValues { result["textValues"] = .object(textValues) }
        return .object(result)
    }
}
