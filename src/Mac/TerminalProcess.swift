import Darwin
import Foundation

final class TerminalProcess: @unchecked Sendable {
    let events: AsyncThrowingStream<JSON, Error>
    private let input: FileHandle
    private let process: Process

    init(root: String) throws {
        guard let executable = Bundle.main.executableURL else { throw AgentError("terminal_unavailable") }
        var masterFD: Int32 = -1
        var slaveFD: Int32 = -1
        var size = winsize(ws_row: 24, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0)
        guard openpty(&masterFD, &slaveFD, nil, nil, &size) == 0 else { throw ScopedFiles.failure() }
        let master = FileHandle(fileDescriptor: masterFD, closeOnDealloc: true)
        let slave = FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)
        let commands = Pipe()
        let control = Pipe()
        input = commands.fileHandleForWriting
        guard fcntl(masterFD, F_SETFD, FD_CLOEXEC) != -1, fcntl(slaveFD, F_SETFD, FD_CLOEXEC) != -1,
              fcntl(masterFD, F_SETFL, O_NONBLOCK) != -1,
              fcntl(input.fileDescriptor, F_SETNOSIGPIPE, 1) != -1,
              fcntl(input.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else {
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

        let stream = AsyncThrowingStream<JSON, Error>.makeStream(bufferingPolicy: .bufferingOldest(64))
        events = stream.stream
        DispatchQueue.global(qos: .utility).async {
            do {
                try Self.relay(master.fileDescriptor, control.fileHandleForReading.fileDescriptor, into: stream.continuation)
                stream.continuation.finish()
            } catch {
                stream.continuation.finish(throwing: error)
            }
            try? master.close()
            try? control.fileHandleForReading.close()
            process.waitUntilExit()
        }
    }

    func send(_ input: JSON) throws {
        var line = try input.encoded()
        guard line.count <= 8192 else { throw AgentError("invalid_request") }
        line.append(10)
        let written = line.withUnsafeBytes { buffer in
            Darwin.write(self.input.fileDescriptor, buffer.baseAddress, buffer.count)
        }
        guard written == line.count else { throw AgentError("terminal_closed") }
    }

    func close() {
        try? input.close()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .seconds(12)) { [process] in
            // Allow the helper to close its command and reap it before forcing cleanup.
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private static func relay(_ master: Int32, _ control: Int32,
                              into output: AsyncThrowingStream<JSON, Error>.Continuation) throws {
        var channels = [pollfd(fd: master, events: Int16(POLLIN), revents: 0),
                        pollfd(fd: control, events: Int16(POLLIN), revents: 0)]
        var pending = Data()
        var buffer = [UInt8](repeating: 0, count: 2048)
        var index: Int64 = 0

        func emit(_ frame: JSON) throws {
            guard case .object(var fields) = frame else { throw AgentError("invalid_terminal_frame") }
            index += 1
            fields["index"] = .integer(index)
            switch output.yield(.object(fields)) {
            case .enqueued: return
            case .dropped: throw AgentError("limit_reached")
            case .terminated: throw CancellationError()
            @unknown default: throw AgentError("terminal_closed")
            }
        }

        func drainPTY() throws {
            while channels[0].fd >= 0 {
                let count = Darwin.read(master, &buffer, buffer.count)
                if count > 0 {
                    try emit(["kind": "output", "data": .string(Data(buffer.prefix(count)).base64EncodedString())])
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
            if channels[0].revents != 0 { try drainPTY() }
            guard channels[1].revents != 0 else { continue }
            let count = Darwin.read(control, &buffer, buffer.count)
            if count == -1 && errno == EINTR { continue }
            guard count >= 0 else { throw ScopedFiles.failure() }
            if count == 0 {
                try drainPTY()
                return
            }
            pending.append(contentsOf: buffer.prefix(count))
            guard pending.count <= 8192 else { throw AgentError("invalid_terminal_frame") }
            while let newline = pending.firstIndex(of: 10) {
                let frame = try JSON.decode(Data(pending[..<newline]))
                pending.removeSubrange(...newline)
                // The child writes its status only after the command stops writing to the PTY.
                try drainPTY()
                try emit(frame)
            }
        }
    }
}
