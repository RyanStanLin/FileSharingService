import Darwin
import Foundation

enum DiagnosticRunner {
    private struct Command: Sendable {
        let path: String
        let arguments: [String]
    }

    private enum Output: Sendable {
        case bytes(String, Data)
        case truncated
        case exit(Int32, Bool)
    }

    private static let commands: [String: Command] = [
        "osVersion": Command(path: "/usr/bin/sw_vers", arguments: []),
        "uptime": Command(path: "/usr/bin/uptime", arguments: []),
        "diskSpace": Command(path: "/bin/df", arguments: ["-k", "-l"])
    ]
    private static let workers = DispatchQueue(label: "FileSharing.diagnostics", qos: .utility, attributes: .concurrent)

    @MainActor
    static func run(_ name: String, data: JSON, emit: (JSON) throws -> Void) async throws -> JSON {
        var capture = ["stdout": Data(), "stderr": Data()]
        var index = 0
        var truncated = false
        var timedOut = false
        var exitCode: Int32 = 0

        func append(_ stream: String, _ bytes: Data) throws {
            index += 1
            try emit(["index": .integer(Int64(index)), "stream": .string(stream),
                      "data": .string(bytes.base64EncodedString())])
            capture[stream, default: Data()].append(bytes)
        }

        if name == "agentHealth" {
            try append("stdout", data.encoded())
        } else {
            guard let command = commands[name] else { throw AgentError("unsupported") }
            for try await event in execute(command) {
                try Task.checkCancellation()
                switch event {
                case .bytes(let stream, let bytes): try append(stream, bytes)
                case .truncated: truncated = true
                case .exit(let status, let expired):
                    exitCode = status
                    timedOut = expired
                }
            }
            try Task.checkCancellation()
        }
        return ["stdout": .string(String(decoding: capture["stdout"] ?? Data(), as: UTF8.self)),
                "stderr": .string(String(decoding: capture["stderr"] ?? Data(), as: UTF8.self)),
                "exitCode": .integer(Int64(exitCode)), "truncated": .boolean(truncated),
                "timedOut": .boolean(timedOut), "data": data]
    }

    private static func execute(_ command: Command) -> AsyncThrowingStream<Output, Error> {
        AsyncThrowingStream { stream in
            let finished = DispatchSemaphore(value: 0)
            stream.onTermination = { reason in
                if case .cancelled = reason { finished.signal() }
            }
            workers.async {
                guard finished.wait(timeout: .now()) == .timedOut else { return }
                let process = Process()
                let stdout = Pipe()
                let stderr = Pipe()
                process.executableURL = URL(fileURLWithPath: command.path)
                process.arguments = command.arguments
                process.currentDirectoryURL = URL(fileURLWithPath: "/")
                process.environment = ["PATH": "/usr/bin:/bin", "LC_ALL": "C"]
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = stdout
                process.standardError = stderr
                process.terminationHandler = { _ in finished.signal() }
                do {
                    try process.run()
                } catch {
                    stream.finish(throwing: AgentError("diagnostic_launch_failed"))
                    return
                }
                try? stdout.fileHandleForWriting.close()
                try? stderr.fileHandleForWriting.close()
                let pipes = DispatchGroup()
                for (name, handle) in [("stdout", stdout.fileHandleForReading), ("stderr", stderr.fileHandleForReading)] {
                    workers.async(group: pipes) { drain(handle, name: name, into: stream) }
                }
                let expired = finished.wait(timeout: .now() + 10) == .timedOut
                if process.isRunning {
                    process.terminate()
                    if finished.wait(timeout: .now() + 1) == .timedOut, process.isRunning {
                        _ = kill(process.processIdentifier, SIGKILL)
                    }
                }
                process.waitUntilExit()
                pipes.wait()
                let code = process.terminationReason == .uncaughtSignal ? 128 + process.terminationStatus : process.terminationStatus
                stream.yield(.exit(code, expired))
                stream.finish()
            }
        }
    }

    private static func drain(_ handle: FileHandle, name: String, into stream: AsyncThrowingStream<Output, Error>.Continuation) {
        defer { try? handle.close() }
        var available = 16 * 1024
        var parts = 24
        var truncated = false
        do {
            while let bytes = try handle.read(upToCount: 4096), !bytes.isEmpty {
                let length = parts > 0 ? min(available, bytes.count) : 0
                if length > 0 {
                    stream.yield(.bytes(name, Data(bytes.prefix(length))))
                    available -= length
                    parts -= 1
                }
                truncated = truncated || length < bytes.count
            }
        } catch {
            truncated = true
        }
        if truncated { stream.yield(.truncated) }
    }
}
