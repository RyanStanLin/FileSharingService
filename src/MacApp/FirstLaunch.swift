import AppKit
import CryptoKit
import Darwin
import OSLog
import ServiceManagement

@MainActor
enum FirstLaunch {
    private static let plistName = "in.ryanl.filesharing.agent.plist"
    private static let installedPath = "/Applications/FileSharingService.app"
    private static let logger = Logger(subsystem: "in.ryanl.filesharing.agent", category: "Setup")
    private static var service: SMAppService { .agent(plistName: plistName) }
    private static var isInstalled: Bool {
        let installed = URL(fileURLWithPath: installedPath)
        let canonical = installed.deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(installed.lastPathComponent)
        return Bundle.main.bundleURL.resolvingSymlinksInPath().path == canonical.path
    }

    static func show() async {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        guard isInstalled else {
            showMessage("请先安装 FileSharingService", "将 App 拖到「应用程序」，然后从「应用程序」打开。")
            return
        }

        let status: SMAppService.Status
        do {
            status = try await registerInstalled()
        } catch {
            let failure = error as NSError
            logger.error("Registration failed: \(failure.domain, privacy: .public) \(failure.code, privacy: .public).")
            showMessage("后台服务注册失败", errorMessage(error))
            return
        }
        let alert = NSAlert()
        switch status {
        case .enabled:
            alert.messageText = "后台服务已注册"
            alert.informativeText = EndpointProfile.localDemo
                ? "请在本机测试页确认 FileSharingService 与服务器的连接状态。"
                : "请在管理后台确认 FileSharingService 与服务器的连接状态。"
            if EndpointProfile.localDemo {
                alert.addButton(withTitle: "打开本机测试页")
            } else {
                alert.addButton(withTitle: "完成")
            }
            alert.addButton(withTitle: "关闭")
            alert.addButton(withTitle: "停用后台服务")
            app.activate()
            let choice = alert.runModal()
            if choice == .alertFirstButtonReturn && EndpointProfile.localDemo {
                NSWorkspace.shared.open(EndpointProfile.origins[0].appendingPathComponent("demo"))
            } else if choice == .alertThirdButtonReturn {
                await disable()
            }
        case .requiresApproval:
            alert.messageText = "请允许后台运行"
            alert.informativeText = "在「登录项与扩展」里允许 FileSharingService，以启动服务并连接服务器。"
            alert.addButton(withTitle: "打开登录项与扩展")
            alert.addButton(withTitle: "关闭")
            app.activate()
            if alert.runModal() == .alertFirstButtonReturn {
                SMAppService.openSystemSettingsLoginItems()
            }
        default:
            showMessage("macOS 尚未登记后台服务", "请重新打开 App。若问题持续，可使用本机的服务启动日志排查。")
        }
    }

    static func check() throws {
        try validateBundle()
        let status = isInstalled ? String(service.status.rawValue) : "not-installed"
        print("agent=\(plistName) status=\(status) server=\(EndpointProfile.origins[0].absoluteString)")
    }

    static func repair() async throws {
        let status = try await registerInstalled(force: true)
        print("agent=\(plistName) status=\(status.rawValue)")
    }

    private static func validateBundle() throws {
        let bundle = Bundle.main.bundleURL
        let definition = bundle.appendingPathComponent("Contents/Library/LaunchAgents/" + plistName)
        guard let data = try? Data(contentsOf: definition),
              let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              plist["Label"] as? String == "in.ryanl.filesharing.agent",
              plist["BundleProgram"] as? String == "Contents/MacOS/FileSharingService",
              plist["ProgramArguments"] as? [String] == ["FileSharingService", "run"] else {
            throw AgentError("invalid_service_layout")
        }
    }

    private static func registerInstalled(force: Bool = false) async throws -> SMAppService.Status {
        guard isInstalled else { throw AgentError("service_install_path_required") }
        try validateBundle()
        let state = try LocalState()
        let lock = try lockRegistration(state)
        defer { close(lock) }
        guard let executable = Bundle.main.executableURL else { throw AgentError("invalid_service_layout") }
        let build = Data(SHA256.hash(data: try Data(contentsOf: executable, options: .mappedIfSafe)))
        let receipt = state.directory.appendingPathComponent("service-registration")
        let background = service
        let status = background.status
        if status == .requiresApproval { return status }
        if status == .enabled {
            if !force, (try? Data(contentsOf: receipt)) == build {
                return status
            }
            try await background.unregister()
            logger.notice("Removed registration for the previous app build.")
        }

        do {
            try background.register()
        } catch {
            guard background.status == .requiresApproval else { throw error }
        }
        let registered = background.status
        if registered == .enabled || registered == .requiresApproval {
            try build.write(to: receipt, options: .atomic)
            logger.notice("Registered the installed app. Service status \(registered.rawValue, privacy: .public).")
        }
        return registered
    }

    private static func disable() async {
        do {
            let state = try LocalState()
            let lock = try lockRegistration(state)
            defer { close(lock) }
            try await service.unregister()
            logger.notice("Stopped the installed app's background service.")
        } catch {
            showMessage("无法停用后台服务", errorMessage(error))
        }
    }

    private static func lockRegistration(_ state: LocalState) throws -> Int32 {
        let path = state.directory.appendingPathComponent("service-registration.lock").path
        let fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw AgentError("service_registration_lock_failed") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw AgentError("service_registration_in_progress")
        }
        return fd
    }

    private static func errorMessage(_ error: Error) -> String {
        guard let failure = error as? AgentError else { return error.localizedDescription }
        if failure.code == "service_registration_in_progress" {
            return "另一个 FileSharingService 窗口正在更新后台服务。"
        }
        return "检查后台服务配置时出错（\(failure.code)）。"
    }

    private static func showMessage(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "关闭")
        NSApplication.shared.activate()
        alert.runModal()
    }
}
