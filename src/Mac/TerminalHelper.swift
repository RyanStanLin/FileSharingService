import Darwin
import Foundation

// This process owns the terminal's cwd. The pipe carries validated requests, separate from the PTY.
final class TerminalHelper: @unchecked Sendable {
    private let root: LocalRoot
    private let files: ScopedFiles
    private let lock = NSLock()
    private let children = DispatchGroup()
    private static let identity: String = {
        var bytes = [CChar](repeating: 0, count: Int(MAXHOSTNAMELEN) + 1)
        let host = gethostname(&bytes, bytes.count) == 0 ? String(cString: bytes) : "Mac"
        return "\(NSUserName())@\(host.split(separator: ".").first ?? "Mac")"
    }()
    private var child: (id: String, process: Process)?

    private init(rootKey: String) throws {
        let state = try LocalState()
        let roots = try state.configuredRoots()
        guard let root = roots.first(where: { $0.rootKey == rootKey }) else {
            throw AgentError("permission_denied")
        }
        self.root = root
        files = ScopedFiles(roots: [root], state: state)
    }

    static func serve(rootKey: String) {
        guard isatty(STDOUT_FILENO) == 1 else { return }
        signal(SIGPIPE, SIG_IGN)
        do {
            try TerminalHelper(rootKey: rootKey).run()
        } catch {
            send(["kind": "error", "code": .string((error as? AgentError)?.code ?? "terminal_unavailable")])
        }
    }

    private func run() throws {
        try changeDirectory("")
        Self.send(["kind": "ready", "prompt": prompt()])
        defer {
            lock.withLock { child?.process.terminate() }
            children.wait()
        }
        while let line = readLine() {
            guard line.utf8.count <= 8192, let input = try? JSON.decode(Data(line.utf8)) else { continue }
            guard let id = input["commandId"].string, UUID(uuidString: id) != nil else { continue }
            if input["kind"].string == "interrupt" {
                lock.withLock {
                    if child?.id == id { child?.process.interrupt() }
                }
                continue
            }
            lock.withLock {
                do {
                    guard child == nil else { throw AgentError("terminal_busy") }
                    let directory = try currentDirectory()
                    switch input["kind"].string {
                    case "cd":
                        try changeDirectory(resolve(input.requireString("path"), relativeTo: directory))
                        exited(id, 0)
                    case "pwd":
                        try FileHandle.standardOutput.write(contentsOf: Data((absolutePath(directory) + "\n").utf8))
                        exited(id, 0)
                    case "run":
                        try start(DiagnosticRunner.customCommand(input), id: id)
                    default:
                        throw AgentError("invalid_diagnostic_command")
                    }
                } catch {
                    exited(id, 1, code: (error as? AgentError)?.code ?? "diagnostic_start_failed")
                }
            }
        }
    }

    private func absolutePath(_ relative: String) -> String {
        relative.isEmpty ? root.path : root.path + "/" + relative
    }

    private func prompt() -> JSON {
        let directory: String
        if let relative = try? currentDirectory() {
            directory = relative.split(separator: "/").last.map(String.init) ?? (root.isHome ? "~" : root.label)
        } else {
            directory = "?"
        }
        return .string("\(Self.identity) \(directory) %")
    }

    private func currentDirectory() throws -> String {
        let cwd = FileManager.default.currentDirectoryPath
        let prefix = root.path + "/"
        guard cwd == root.path || cwd.hasPrefix(prefix) else { throw AgentError("invalid_path") }
        let relative = cwd == root.path ? "" : String(cwd.dropFirst(prefix.count))
        let approved = try files.terminalDirectory(rootKey: root.rootKey, path: relative)
        let info = try approved.info()
        var actual = stat()
        guard stat(".", &actual) == 0, actual.st_ino == info.st_ino, actual.st_dev == info.st_dev else {
            throw AgentError("root_identity_changed")
        }
        return relative
    }

    private func changeDirectory(_ relative: String) throws {
        let directory = try files.terminalDirectory(rootKey: root.rootKey, path: relative)
        guard fchdir(directory.fd) == 0 else { throw ScopedFiles.failure() }
    }

    private func resolve(_ path: String, relativeTo cwd: String) throws -> String {
        guard !path.isEmpty, path.utf8.count <= 3000, !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              !path.contains(where: { "|&;<>`$\\".contains($0) }) else {
            throw AgentError("invalid_path")
        }
        if path == "/" || path == "~" { return "" }
        let rooted = path.hasPrefix("/") || path.hasPrefix("~/")
        let relative = rooted ? path.dropFirst(path.hasPrefix("~/") ? 2 : 1) : path[...]
        var parts = rooted ? [] : cwd.split(separator: "/")
        for part in relative.split(separator: "/") {
            switch part {
            case ".": continue
            case "..":
                guard parts.popLast() != nil else { throw AgentError("invalid_path") }
            default: parts.append(part)
            }
        }
        return parts.joined(separator: "/")
    }

    private func start(_ command: DiagnosticRunner.Command, id: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.path)
        process.arguments = command.arguments
        process.environment = ["PATH": "/usr/bin:/bin", "LC_ALL": "C", "TERM": "dumb"]
        process.standardInput = FileHandle.standardOutput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardOutput
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        try process.run()
        child = (id, process)
        children.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { self.children.leave() }
            let expired = done.wait(timeout: .now() + .seconds(10)) == .timedOut
            if expired {
                process.terminate()
                if done.wait(timeout: .now() + .milliseconds(500)) == .timedOut {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                    done.wait()
                }
            }
            self.lock.withLock {
                let status = process.terminationStatus
                let exit = process.terminationReason == .uncaughtSignal ? status + 128 : status
                self.exited(id, expired ? 124 : exit, code: expired ? "diagnostic_timeout" : nil)
                self.child = nil
            }
        }
    }

    private func exited(_ id: String, _ status: Int32, code: String? = nil) {
        var frame: [String: JSON] = ["kind": "exit", "commandId": .string(id),
                                     "exitCode": .integer(Int64(status)), "prompt": prompt()]
        if let code { frame["code"] = .string(code) }
        Self.send(.object(frame))
    }

    private static func send(_ frame: JSON) {
        guard var bytes = try? frame.encoded() else { return }
        bytes.append(10)
        try? FileHandle.standardError.write(contentsOf: bytes)
    }
}
