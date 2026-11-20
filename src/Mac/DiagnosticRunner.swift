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

    static func run(_ name: String, input: JSON, data: JSON, emit: @Sendable (JSON) async throws -> Void) async throws -> JSON {
        var capture = ["stdout": Data(), "stderr": Data()]
        var index = 0
        var truncated = false
        var timedOut = false
        var exitCode: Int32 = 0

        func append(_ stream: String, _ bytes: Data) async throws {
            index += 1
            try await emit(["index": .integer(Int64(index)), "stream": .string(stream),
                      "data": .string(bytes.base64EncodedString())])
            capture[stream, default: Data()].append(bytes)
        }

        if name == "agentHealth" {
            try await append("stdout", data.encoded())
        } else {
            guard let command = name == "custom" ? try customCommand(input) : commands[name] else {
                throw AgentError("unsupported")
            }
            for try await event in execute(command) {
                try Task.checkCancellation()
                switch event {
                case .bytes(let stream, let bytes): try await append(stream, bytes)
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

    // Validate independently of the server. Only fixed executable paths and reviewed arguments reach Process.
    private static func customCommand(_ input: JSON) throws -> Command {
        guard let executable = input["executable"].string, let values = input["arguments"].array, values.count <= 8 else {
            throw AgentError("invalid_diagnostic_command")
        }
        let args = values.compactMap(\.string)
        guard values.count == args.count else { throw AgentError("invalid_diagnostic_command") }
        let path: String
        switch executable {
        case "sw_vers" where args.isEmpty || (args.count == 1 && ["-productName", "-productVersion", "-buildVersion"].contains(args[0])):
            path = "/usr/bin/sw_vers"
        case "uptime" where args.isEmpty:
            path = "/usr/bin/uptime"
        case "whoami" where args.isEmpty:
            path = "/usr/bin/whoami"
        case "df" where diagnosticFlags(args, allowed: "hkl"):
            path = "/bin/df"
        case "uname" where diagnosticFlags(args, allowed: "amnprsv"):
            path = "/usr/bin/uname"
        case "date" where args.isEmpty || args == ["-u"]:
            path = "/bin/date"
        case "pmset" where args == ["-g"] || (args.count == 2 && args[0] == "-g" && ["batt", "cap", "custom", "therm"].contains(args[1])):
            path = "/usr/bin/pmset"
        case "sysctl" where safeSysctl(args):
            path = "/usr/sbin/sysctl"
        default:
            throw AgentError("invalid_diagnostic_command")
        }
        return Command(path: path, arguments: args)
    }

    private static func diagnosticFlags(_ arguments: [String], allowed: String) -> Bool {
        arguments.allSatisfy { arg in
            (2...8).contains(arg.utf8.count) && arg.hasPrefix("-") && arg.utf8.dropFirst().allSatisfy(allowed.utf8.contains)
        }
    }

    private static func safeSysctl(_ arguments: [String]) -> Bool {
        let keys = arguments.first == "-n" ? arguments.dropFirst() : arguments[...]
        let allowed: Set<String> = ["hw.model", "hw.ncpu", "hw.logicalcpu", "hw.memsize", "kern.osrelease", "kern.osversion", "machdep.cpu.brand_string"]
        return !keys.isEmpty && keys.allSatisfy(allowed.contains)
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
