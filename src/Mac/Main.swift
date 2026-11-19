import AppKit
import Darwin
import Foundation
import OSLog

@main
struct FileSharingAgent {
    @MainActor
    static func main() {
        _ = umask(0o077)
        let arguments = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
        if arguments == ["version"] {
            print(Telemetry.version)
            return
        }
        #if !FILESHARING_TEST
        guard getuid() >= 501 else { return }
        if let user = EndpointProfile.managedUser, user != NSUserName() { return }
        #endif
        #if FILESHARING_APP || FILESHARING_TEST
        if arguments.isEmpty || arguments == ["run"] {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            Task { await execute(arguments); exit(EXIT_SUCCESS) }
            app.run()
            return
        }
        #endif
        Task { await execute(arguments); exit(EXIT_SUCCESS) }
        dispatchMain()
    }

    @MainActor
    private static func execute(_ arguments: [String]) async {
        do {
            #if FILESHARING_APP
            if arguments.isEmpty {
                await FirstLaunch.show()
                return
            }
            if arguments == ["service-status"] {
                try FirstLaunch.check()
                return
            }
            if arguments == ["service-repair"] {
                try await FirstLaunch.repair()
                return
            }
            #endif
            let state = try LocalState()
            switch arguments.first {
            case "roots":
                try updateRoots(state, arguments: Array(arguments.dropFirst()))
            case nil, "run":
                let enrollment = try state.loadOrCreate(homeWritable: EndpointProfile.homeWritable)
                let transport = AgentTransport(enrollment: enrollment, state: state)
                await transport.run()
            default:
                throw AgentError("usage_run_roots_version")
            }
        } catch {
            let reason = (error as? AgentError)?.code ?? "local_operation_failed"
            let failure = error as NSError
            Logger(subsystem: "in.ryanl.filesharing.agent", category: "Startup")
                .error("Startup failed: \(reason, privacy: .public) (\(failure.domain, privacy: .public) \(failure.code, privacy: .public)).")
            FileHandle.standardError.write(Data("FileSharingAgent: \(reason)\n".utf8))
            exit(1)
        }
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
