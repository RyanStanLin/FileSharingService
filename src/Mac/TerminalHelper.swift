import Darwin
import Foundation

// This process owns the terminal's cwd. The pipe carries requests, separate from the PTY.
final class TerminalHelper: @unchecked Sendable {
    private let root: LocalRoot
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
        let initialPath = FileManager.default.fileExists(atPath: root.path) ? root.path : NSHomeDirectory()
        try changeDirectory(initialPath)
        Self.send(["kind": "ready", "prompt": prompt(), "interactive": true])
        defer { stopChild() }
        while let line = readLine() {
            guard line.utf8.count <= 8192, let input = try? JSON.decode(Data(line.utf8)) else { continue }
            if input["kind"].string == "resize" {
                lock.withLock { resize(input) }
                continue
            }
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
                    let directory = currentDirectory()
                    switch input["kind"].string {
                    case "cd":
                        let target = resolve(try input.requireString("path"), relativeTo: directory)
                        try changeDirectory(target)
                        exited(id, 0)
                    case "pwd":
                        try FileHandle.standardOutput.write(contentsOf: Data((currentDirectory() + "\n").utf8))
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

    private func stopChild() {
        let process = lock.withLock { child?.process }
        if let process, process.isRunning {
            process.terminate()
            if process.isRunning { kill(process.processIdentifier, SIGCONT) }
            if children.wait(timeout: .now() + .seconds(2)) == .timedOut, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        children.wait()
    }

    private func prompt() -> JSON {
        let cwd = currentDirectory()
        let home = NSHomeDirectory()
        let directory: String
        if cwd == home {
            directory = "~"
        } else if cwd == "/" {
            directory = "/"
        } else if cwd.hasPrefix(home + "/") {
            let relative = String(cwd.dropFirst(home.count + 1))
            directory = relative.split(separator: "/").last.map(String.init) ?? "~"
        } else {
            directory = cwd.split(separator: "/").last.map(String.init) ?? "/"
        }
        return .string("\(Self.identity) \(directory) %")
    }

    private func currentDirectory() -> String {
        FileManager.default.currentDirectoryPath
    }

    private func changeDirectory(_ path: String) throws {
        guard FileManager.default.changeCurrentDirectoryPath(path) else {
            throw AgentError("invalid_path")
        }
    }

    private func resolve(_ path: String, relativeTo cwd: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "~" {
            return NSHomeDirectory()
        }
        if trimmed.hasPrefix("~/") {
            return (NSHomeDirectory() as NSString).appendingPathComponent(String(trimmed.dropFirst(2)))
        }
        if trimmed.hasPrefix("/") {
            return URL(fileURLWithPath: trimmed).standardized.path
        }
        return URL(fileURLWithPath: cwd).appendingPathComponent(trimmed).standardized.path
    }

    private func start(_ command: DiagnosticRunner.Command, id: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.path)
        process.arguments = command.arguments
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
                               "LC_CTYPE": "UTF-8", "TERM": "xterm-256color"]
        process.standardInput = FileHandle.standardOutput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardOutput
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        _ = tcflush(STDOUT_FILENO, TCIFLUSH)
        try process.run()
        child = (id, process)
        Self.send(["kind": "started", "commandId": .string(id)])
        children.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { self.children.leave() }
            done.wait()
            self.lock.withLock {
                let status = process.terminationStatus
                let exit = process.terminationReason == .uncaughtSignal ? status + 128 : status
                _ = tcflush(STDOUT_FILENO, TCIFLUSH)
                self.exited(id, exit)
                self.child = nil
            }
        }
    }

    private func resize(_ input: JSON) {
        guard let rows = input["rows"].int, let columns = input["columns"].int,
              (2...160).contains(rows), (2...300).contains(columns) else { return }
        var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)
        // Darwin _IOW('t', 103, struct winsize), absent from Swift's imported macros.
        guard ioctl(STDOUT_FILENO, 0x80087467, &size) == 0 else { return }
        if let process = child?.process, process.isRunning {
            kill(process.processIdentifier, SIGWINCH)
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
