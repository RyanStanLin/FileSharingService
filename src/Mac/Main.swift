import AppKit
import Darwin
import Foundation

@main
struct FileSharingAgent {
    @MainActor
    static func main() async {
        _ = umask(0o077)
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments == ["version"] {
                print(Telemetry.version)
                return
            }
            #if !FILESHARING_TEST
            guard getuid() != 0, NSUserName() == EndpointProfile.managedUser else { return }
            #endif
            let state = try LocalState()
            switch arguments.first {
            #if FILESHARING_TEST
            case "activate":
                guard let code = readLine(), code.count == 43 else { throw AgentError("activation_code_required") }
                try await enroll(state, code: code, roots: [LocalRoot.authorize(path: LocalState.home.path, write: true)])
            #endif
            case "roots":
                try updateRoots(state, arguments: Array(arguments.dropFirst()))
            case nil, "run":
                _ = NSApplication.shared
                let enrollment = try await loadOrEnroll(state)
                let transport = AgentTransport(enrollment: enrollment, key: try state.privateKey(), state: state)
                await transport.run()
            default:
                throw AgentError("usage_run_roots_version")
            }
        } catch {
            let reason = (error as? AgentError)?.code ?? "local_operation_failed"
            FileHandle.standardError.write(Data("FileSharingAgent: \(reason)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    private static func loadOrEnroll(_ state: LocalState) async throws -> Enrollment {
        if let saved = try? state.enrollment() { return saved }
        guard let code = EndpointProfile.activation else { throw AgentError("activation_required") }
        let home = try LocalRoot.authorize(path: LocalState.home.path(percentEncoded: false), write: EndpointProfile.homeWritable)
        var delay = 1.0
        while !Task.isCancelled {
            do {
                try await enroll(state, code: code, roots: [home])
                return try state.enrollment()
            } catch let error as AgentError where ["authentication_required", "device_capacity_or_key_in_use"].contains(error.code) {
                throw error
            } catch {
                try await Task.sleep(for: .seconds(delay * Double.random(in: 0.75...1.25)))
                delay = min(delay * 2, 30)
            }
        }
        throw CancellationError()
    }

    @MainActor
    private static func enroll(_ state: LocalState, code: String, roots: [LocalRoot]) async throws {
        guard (try? state.enrollment()) == nil else { throw AgentError("already_activated") }
        let key = try state.privateKey()
        let connection = AgentHttp.createSession()
        defer { connection.finishTasksAndInvalidate() }
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let body: JSON = ["code": .string(code), "name": .string(name), "publicKey": .string(key.publicKey.x963Representation.base64URL)]
        for origin in EndpointProfile.origins {
            do {
                let result = try await AgentHttp(session: connection, base: origin).call("activate", body: body)
                let id = try result.requireString("deviceId")
                guard UUID(uuidString: id) != nil else { throw AgentError("invalid_activation_response") }
                try state.save(Enrollment(deviceId: id, roots: roots))
                print("FileSharing device \(id)")
                return
            } catch let error as AgentError where error.code != "connection_unavailable" {
                throw error
            } catch {
                #if FILESHARING_TEST
                let issue = error as NSError
                FileHandle.standardError.write(Data("Enrollment transport: \(issue.domain)/\(issue.code)\n".utf8))
                #endif
                continue
            }
        }
        throw AgentError("connection_unavailable")
    }

    private static func updateRoots(_ state: LocalState, arguments: [String]) throws {
        let saved = try state.enrollment()
        guard arguments.count >= 2 else { throw AgentError("usage_roots_add_read_or_write_absolute_path_or_remove_uuid") }
        var roots = saved.roots
        switch arguments[0] {
        case "add" where arguments.count == 3 && ["read", "write"].contains(arguments[1]):
            let candidate = try LocalRoot.authorize(path: arguments[2], write: arguments[1] == "write")
            guard roots.count < 24, !roots.contains(where: { $0.path == candidate.path }) else { throw AgentError("root_already_configured") }
            roots.append(candidate)
        case "remove" where arguments.count == 2:
            roots.removeAll { $0.rootKey == arguments[1] }
        default: throw AgentError("invalid_request")
        }
        try state.save(Enrollment(deviceId: saved.deviceId, roots: roots))
        print("Saved \(roots.count) managed directories. Restart the agent to apply the change.")
    }
}
