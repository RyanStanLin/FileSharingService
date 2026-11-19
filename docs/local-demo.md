# 本机联调

浏览器访问 `http://localhost:8847/demo`。本机 DMG 的服务端地址为 `http://localhost:8847`，服务端只绑定回环地址。Agent 使用只读 HOME 和独立本机状态。

1. 打开 `artifacts/FileSharingService-0.3.1.dmg`，把 `FileSharingService.app` 拖到 `Applications`。升级已装的测试包时，先在终端运行 `open -n /Applications/FileSharingService.app` 打开旧版状态窗口，点击「停用后台服务」，再替换 App。
2. 打开已拖装的 App，也可以在 DMG 里双击 `Open FileSharingService.command`。若 macOS 暂拦首次启动，从「系统设置 → 隐私与安全性」为此 App 选择「仍要打开」。[Apple 的首次打开说明](https://support.apple.com/en-us/102445)
3. App 会注册内置后台服务。系统要求批准时，在「登录项与扩展」允许 FileSharingService。可以从 App 的状态窗口打开本机测试页。
4. 首次使用网页时，打开仓库的 `.local/demo/.env`，把 `FILESHARING_BOOTSTRAP_SECRET` 等号后的值粘贴到部署密钥栏，注册 Passkey 并解锁。建议使用系统当前版本的 Safari 或 Chrome。
5. 选在线设备并点击「授权当前连接」。在「系统权限」点击「下载目录」的「申请」，在 Mac 系统弹窗里选择允许。网页会显示通过 WebSocket 推送回来的检测状态。再点击「下载」或在路径框输入 `Downloads`，列出文件，对合适的文本文件点击「预览」确认内容。
6. 申请剪贴板后，在这台 Mac 上处理系统提示。网页会显示探测进度和 macOS 回报的状态。「需系统设置」表示 macOS 配置为每次询问，可在「隐私与安全性 → 剪贴板」调整。系统按应用和当前策略决定是否显示提示。 [Apple 剪贴板权限说明](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum)

可再次打开 App 查看状态或停用其后台服务。本机服务器可以用 `scripts/demo-server.sh status` 检查、用 `scripts/demo-server.sh stop` 停止。日志和测试数据库都位于 `.local/demo`。

## 构建和验收

打开 `FileSharingService.xcodeproj` 即可管理 App 与 Agent 源码。运行脚本重新构建 DMG 和 SHA-256 校验文件。

```bash
scripts/build-agent.sh dmg
scripts/test-local.sh
python3 tests/demo_browser.py
```

DMG 以无 Developer ID、无公证方式交付，App 使用 Xcode 的本地 ad-hoc 签名。浏览器回归使用独立 Chrome、虚拟 Passkey 和隔离文件夹，模拟剪贴板权限调用阻塞并验证 Agent 在轮询期间仍能处理目录权限和文件预览。实机验收从 DMG 安装并启用登录项后开始，检查自动登记、持续心跳、剪贴板和文件夹原生权限提示，以及文件读取。 [Apple 的本地签名说明](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes) · [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
