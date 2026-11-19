import AppKit
import ServiceManagement

@MainActor
enum FirstLaunch {
    private static let plistName = "in.ryanl.filesharing.agent.plist"
    private static var service: SMAppService { .agent(plistName: plistName) }

    static func show() async {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let background = service
        var registrationError: Error?
        let status = background.status
        if status == .notRegistered || status == .notFound {
            do { try background.register() }
            catch { registrationError = error }
        }

        let alert = NSAlert()
        switch background.status {
        case .enabled:
            alert.messageText = "后台服务已启用"
            alert.informativeText = "FileSharingService 会在登录后自动运行。"
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
                await disable(background)
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
            alert.alertStyle = .warning
            alert.messageText = "后台服务注册失败"
            alert.informativeText = registrationError?.localizedDescription ?? "请将 App 拖入 Applications 后重新打开。"
            alert.addButton(withTitle: "关闭")
            app.activate()
            alert.runModal()
        }
    }

    static func check() throws {
        let bundle = Bundle.main.bundleURL
        let definition = bundle.appendingPathComponent("Contents/Library/LaunchAgents/" + plistName)
        guard let data = try? Data(contentsOf: definition),
              let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              plist["Label"] as? String == "in.ryanl.filesharing.agent",
              plist["BundleProgram"] as? String == "Contents/MacOS/FileSharingService" else {
            throw AgentError("invalid_service_layout")
        }
        print("agent=\(plistName) status=\(service.status.rawValue) server=\(EndpointProfile.origins[0].absoluteString)")
    }

    private static func disable(_ background: SMAppService) async {
        do {
            try await background.unregister()
        } catch {
            NSAlert(error: error).runModal()
        }
    }
}
