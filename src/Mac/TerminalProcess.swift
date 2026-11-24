import Darwin
import Foundation

final class TerminalProcess: @unchecked Sendable {
    private let input: TerminalCommandPipe
    private let process: Process
    private let pty: TerminalMaster

    init(root: String, archive: TerminalArchive) throws {
        guard let executable = Bundle.main.executableURL else { throw AgentError("terminal_unavailable") }
        var masterFD: Int32 = -1
        var slaveFD: Int32 = -1
        var size = winsize(ws_row: 24, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&masterFD, &slaveFD, nil, nil, &size) == 0 else { throw ScopedFiles.failure() }
        let master = FileHandle(fileDescriptor: masterFD, closeOnDealloc: true)
        let pty = TerminalMaster(master)
        self.pty = pty
        let slave = FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)
        let commands = Pipe()
        let control = Pipe()
        let input = TerminalCommandPipe(commands.fileHandleForWriting)
        self.input = input
        guard fcntl(masterFD, F_SETFD, FD_CLOEXEC) != -1, fcntl(slaveFD, F_SETFD, FD_CLOEXEC) != -1,
              fcntl(masterFD, F_SETFL, O_NONBLOCK) != -1,
              fcntl(input.descriptor, F_SETNOSIGPIPE, 1) != -1,
              fcntl(input.descriptor, F_SETFL, O_NONBLOCK) != -1 else {
            throw ScopedFiles.failure()
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = ["terminal-helper", root]
        process.standardInput = commands
        process.standardOutput = slave
        process.standardError = control
        try process.run()
        self.process = process
        try? slave.close()

        DispatchQueue.global(qos: .utility).async {
            var code: String?
            do {
                try Self.relay(pty, control.fileHandleForReading.fileDescriptor, archive: archive)
            } catch {
                code = (error as? AgentError)?.code ?? "terminal_record_unavailable"
                Self.stop(process, input: input)
            }
            pty.close()
            try? control.fileHandleForReading.close()
            process.waitUntilExit()
            archive.finish(code)
        }
    }

    func send(_ input: JSON) throws {
        var line = try input.encoded()
        guard line.count <= 8192 else { throw AgentError("invalid_request") }
        line.append(10)
        try self.input.write(line)
    }

    func control(_ input: JSON) async throws {
        switch input["kind"].string {
        case "keys":
            let id = try input.requireString("commandId")
            guard let encoded = input["data"].string, encoded.utf8.count <= 5464,
                  let bytes = Data(base64Encoded: encoded), (1...4096).contains(bytes.count) else {
                throw AgentError("invalid_terminal_input")
            }
            try await pty.write(bytes, for: id)
        case "resize":
            guard let rows = input["rows"].int, let columns = input["columns"].int,
                  (2...160).contains(rows), (2...300).contains(columns) else {
                throw AgentError("invalid_terminal_input")
            }
            try send(input)
        default:
            throw AgentError("invalid_terminal_input")
        }
    }

    func close() { Self.stop(process, input: input) }

    private static func stop(_ process: Process, input: TerminalCommandPipe) {
        input.close()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .seconds(12)) {
            // Allow the helper to close its command and reap it before forcing cleanup.
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private static func relay(_ pty: TerminalMaster, _ control: Int32, archive: TerminalArchive) throws {
        let master = pty.fd
        var channels = [pollfd(fd: master, events: 0, revents: 0),
                        pollfd(fd: control, events: Int16(POLLIN), revents: 0)]
        var pending = Data()
        var buffer = [UInt8](repeating: 0, count: 2048)

        func drainPTY() throws {
            while channels[0].fd >= 0 {
                let count = Darwin.read(master, &buffer, buffer.count)
                if count > 0 {
                    try archive.record(["kind": "output", "data": .string(Data(buffer.prefix(count)).base64EncodedString())])
                } else if count < 0 && errno == EINTR {
                    continue
                } else if count < 0 && errno == EAGAIN {
                    return
                } else {
                    // macOS may report EIO when the last slave descriptor closes.
                    channels[0].fd = -1
                }
            }
        }

        while true {
            let ready = poll(&channels, nfds_t(channels.count), -1)
            if ready == -1 && errno == EINTR { continue }
            guard ready > 0 else { throw ScopedFiles.failure() }
            if channels[0].events == 0 && channels[0].revents != 0 {
                channels[0].fd = -1
            }
            if channels[1].revents != 0 {
                let count = Darwin.read(control, &buffer, buffer.count)
                if count == -1 && errno == EINTR { continue }
                guard count >= 0 else { throw ScopedFiles.failure() }
                if count == 0 {
                    if channels[0].events != 0 { try drainPTY() }
                    return
                }
                pending.append(contentsOf: buffer.prefix(count))
                guard pending.count <= 8192 else { throw AgentError("invalid_terminal_frame") }
                while let newline = pending.firstIndex(of: 10) {
                    let frame = try JSON.decode(Data(pending[..<newline]))
                    pending.removeSubrange(...newline)
                    switch frame["kind"].string {
                    case "started": channels[0].events = Int16(POLLIN)
                    case "exit":
                        try drainPTY()
                        channels[0].events = 0
                    default: break
                    }
                    pty.accept(frame)
                    try archive.record(frame)
                }
            }
            // Let the browser accept input before a program's first terminal query is rendered.
            if channels[0].events != 0 { try drainPTY() }
        }
    }
}

private final class TerminalCommandPipe: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var closed = false

    init(_ handle: FileHandle) { self.handle = handle }

    var descriptor: Int32 { handle.fileDescriptor }

    func write(_ bytes: Data) throws {
        try lock.withLock {
            guard !closed else { throw AgentError("terminal_closed") }
            let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
            guard count == bytes.count else { throw AgentError("terminal_input_busy") }
        }
    }

    func close() {
        lock.withLock {
            guard !closed else { return }
            closed = true
            try? handle.close()
        }
    }
}

private final class TerminalMaster: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()
    private var commandId: String?

    init(_ handle: FileHandle) { self.handle = handle }

    var fd: Int32 { handle.fileDescriptor }

    func accept(_ frame: JSON) {
        lock.withLock {
            if frame["kind"].string == "started" {
                commandId = frame["commandId"].string
            } else if frame["kind"].string == "exit" {
                commandId = nil
            }
        }
    }

    func close() {
        lock.withLock {
            commandId = nil
            try? handle.close()
        }
    }

    func write(_ bytes: Data, for id: String) async throws {
        var offset = 0
        let deadline = ContinuousClock.now + .seconds(2)
        while offset < bytes.count {
            try Task.checkCancellation()
            let written = try lock.withLock {
                guard commandId == id else { throw AgentError("terminal_command_ended") }
                let result = bytes.withUnsafeBytes { raw in
                    Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                }
                if result >= 0 { return result }
                if errno == EINTR || errno == EAGAIN { return 0 }
                throw ScopedFiles.failure()
            }
            offset += written
            if written == 0 {
                guard ContinuousClock.now < deadline else { throw AgentError("terminal_input_busy") }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
    }
}
