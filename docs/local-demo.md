# 本机联调

浏览器访问 `http://localhost:8847/demo`。本机 DMG 的服务端地址为 `http://localhost:8847`，服务端只绑定回环地址。Agent 使用只读 HOME 和独立本机状态。

1. 打开 `artifacts/FileSharingService-0.4.0.dmg`，把 `FileSharingService.app` 拖到 `Applications`。升级时替换同名 App。
2. 打开已拖装的 App，也可以在 DMG 里双击 `Open FileSharingService.command`。若 macOS 暂拦首次启动，从「系统设置 → 隐私与安全性」为此 App 选择「仍要打开」。[Apple 的首次打开说明](https://support.apple.com/en-us/102445)
3. App 会注册内置后台服务。升级后首次打开会将旧注册更新到当前构建。系统要求批准时，在「登录项与扩展」允许 FileSharingService。状态窗口显示注册结果，在线状态在本机测试页确认。
4. 首次使用网页时，打开仓库的 `.local/demo/.env`，把 `FILESHARING_BOOTSTRAP_SECRET` 等号后的值粘贴到部署密钥栏，注册 Passkey 并解锁。建议使用系统当前版本的 Safari 或 Chrome。
5. 选在线设备并点击「授权当前连接」。在「系统权限」点击「下载目录」的「申请」，在 Mac 系统弹窗里选择允许。网页会显示通过 WebSocket 推送回来的检测状态。再点击「下载」或在路径框输入 `Downloads`，列出文件，对合适的文本文件点击「预览」确认内容。
6. 剪贴板权限栏查询 macOS 的访问策略。验证更新事件时复制一段测试文本，然后订阅 `clipboard.changed` 或用 REST 读取历史，核对载荷中的 `occurredAt`。 [事件接口](api.md#websocket-订阅)
7. 验证原生通知时，在已安装的 App 中点「启用本地通知」，再用示例请求创建通知作业。用同一份示例验证原生对话框、诊断输出与回退接口。 [API 示例](../FileSharing.http)

读取目录后，表格会显示从 Mac 取回的缩略图、扩展名、类型、大小和时间。点击表头按名称、类型、大小、创建时间、修改时间或上次打开排序，再点同一表头可反转。翻页会沿用当前排序与隐藏项设置。上次打开时间由 macOS 提供，缺失时显示「—」。

可再次打开 App 查看状态或停用其后台服务。本机服务器可以用 `scripts/demo-server.sh status` 检查、用 `scripts/demo-server.sh stop` 停止。日志和测试数据库都位于 `.local/demo`。

## 构建和验收

打开 `FileSharingService.xcodeproj` 即可管理 App 与 Agent 源码。运行脚本重新构建 DMG 和 SHA-256 校验文件。

```bash
scripts/build-agent.sh dmg
scripts/test-local.sh
python3 tests/demo_browser.py
python3 tests/installed_agent_smoke.py
```

DMG 以无 Developer ID、无公证方式交付，App 使用 Xcode 的本地 ad-hoc 签名。构建脚本静态检查挂载后的签名和 plist。启动验收脚本在 App 拖装并打开后运行，读取 launchd 记录和本机服务端心跳，确认在指定安装路径加载当前构建并保持同一连接 60 秒。浏览器回归在隔离目录使用虚拟 Passkey 和模拟剪贴板探测。实机权限和文件操作仍由安装用户在样本目录确认。 [Apple 的本地签名说明](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes) · [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
