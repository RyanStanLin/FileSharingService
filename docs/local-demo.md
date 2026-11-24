# 本机联调

运行 `scripts/demo-server.sh start`，然后访问 `http://localhost:8847/demo`。本机 DMG 的服务端地址为 `http://localhost:8847`。网页、FTP、FTPS 和 SFTP 均只监听回环地址。Agent 使用独立本机状态。默认 HOME 共享允许在本机用户有写权限的普通路径上修改。演示脚本需要 .NET 10、Go 和 OpenSSL。

1. 打开 `artifacts/FileSharingService-0.5.6.dmg`，把 `FileSharingService.app` 拖到 `Applications`。升级时替换同名 App。
2. 打开已拖装的 App，也可以在 DMG 里双击 `Open FileSharingService.command`。若 macOS 暂拦首次启动，从「系统设置 → 隐私与安全性」为此 App 选择「仍要打开」。[Apple 的首次打开说明](https://support.apple.com/en-us/102445)
3. App 会注册内置后台服务。升级后首次打开会将旧注册更新到当前构建。系统要求批准时，在「登录项与扩展」允许 FileSharingService。状态窗口显示注册结果，在线状态在本机测试页确认。客户端或服务端重启后，在 Demo 里为新的设备连接授权。
4. 首次使用网页时，打开仓库的 `.local/demo/.env`，把 `FILESHARING_BOOTSTRAP_SECRET` 等号后的值粘贴到部署密钥栏，注册 Passkey 并解锁。建议使用系统当前版本的 Safari 或 Chrome。
5. 选在线设备并点击「授权当前连接」。在「系统权限」点击「下载目录」的「申请」，在 Mac 系统弹窗里选择允许。网页会显示通过 WebSocket 推送回来的检测状态。再点击「下载」或在路径框输入 `Downloads`，列出文件，对合适的文本文件点击「预览」确认内容。
6. 剪贴板权限栏查询 macOS 的访问策略。验证更新事件时复制一段测试文本，打开「历史记录 → 剪贴板更新」并刷新。进入详情核对发生时间、入库时间和 Agent 上报的 `N/A`。 [查询 API](api.md#交互与剪贴板历史)
7. 验证原生通知时，在已安装的 App 中点「启用本地通知」，再用示例请求创建通知作业。用同一份示例验证原生对话框、诊断输出与回退接口。 [API 示例](../FileSharing.http)
8. 在「诊断与交互 → 远程终端」点击「新建会话」，依次执行 `cd Downloads`、`pwd` 和 `uname -m`，核对提示符的目录名、实时输出和退出码。 [终端 API](api.md#远程终端会话)

读取目录后，表格会显示从 Mac 取回的缩略图、扩展名、类型、大小和时间。点击表头按名称、类型、大小、创建时间、修改时间或上次打开排序，再点同一表头可反转。翻页会沿用当前排序与隐藏项设置。上次打开时间由 macOS 提供，缺失时显示「—」。

| Demo 入口 | 联调方式 |
| --- | --- |
| 设备与电源 | 查询设备、CPU、内存、电池、网络、外接存储和开合盖。可修改每项采样间隔或请求即时采样，也可保存、恢复继承合盖保持唤醒策略。本机联调包的实际睡眠由 macOS 控制，页面显示 Mac 回报的有效状态。 |
| 应用直播 | 查看运行中与已安装的应用清单，按名称、Bundle ID 或 PID 搜索。启动或退出一个测试 App，查看事件和清单变化。WebSocket 断线时，页面回退到 REST 并补读事件。 |
| 诊断与交互 | 选择预设诊断或「自定义只读命令」，例如 `uname -m`，查看 STDOUT、STDERR 和退出码。Agent 0.4.6 起只显示填写的选项。两个短按钮会横排，Escape 可取消。Agent 0.5.1 的「自定义输入框」可添加多个字段，分别设置提示、预填、禁用、必填和遮蔽。答复区按字段显示结果。 |
| 历史记录 | 选择设备后切换「对话框答复」或「剪贴板更新」。可刷新、翻页并点击「查看详情」。表单在详情中显示所选选项和实际提交值，遮蔽字段沿用原设置。设备离线后仍可查看。 |
| FTP / SFTP | 创建测试账号，可留空密码以随机生成。用独立客户端连接并回到页面查看会话。轮换密码会使旧连接失效。查看历史已签发的可查询密码时，页面会按需重新验证 Passkey。 |

网关端口为 FTP 2121、显式 FTPS 2122、隐式 FTPS 2990 和 SFTP 2222。FTPS 客户端可校验或导入本机公共证书 `.local/demo/ftps-cert.pem`。SFTP 主机指纹显示在页面中。页面创建的账号会看到所有已授权在线 Mac 的主目录。

在 Finder 选择「前往 → 连接服务器」，完整输入 `ftp://localhost:2121/`，用 Demo 中的 FTP 账号登录。也可用 `ftp://127.0.0.1:2121/`。macOS 将 FTP 挂载为只读卷，可把文件复制到本机。写入请通过 File System 网页或文件 API。Royal TSX 等独立客户端可使用端口 2121 的主动或被动 FTP 下载。登录后先列 `/`，进入当前 Mac 的设备目录，再进入 `Downloads` 等子目录。[Apple 的 Finder FTP 说明](https://support.apple.com/guide/mac-help/servers-shared-computers-connect-mac-mchlp3015/mac)

在 File System 网页进入 HOME 或 `Projects` 等普通目录，即可试用新建、上传、改名和移动。Downloads、Documents、Desktop 的访问使用 macOS 已授予的权限。`~/Library` 和 `~/Applications` 按只读目录处理。 [File System 网页](../web/README.md)

升级 Agent 后，历史 HOME 共享记录会迁移到稳定的卷 UUID，已有设备与目录标识可继续使用。若新版返回 `root_identity_changed`，请在 Mac 上核对共享根的实际位置和卷，再重新批准该目录。

可再次打开 App 查看状态或停用其后台服务。本机服务器可以用 `scripts/demo-server.sh status` 检查、用 `scripts/demo-server.sh stop` 停止。日志和测试数据库都位于 `.local/demo`。

Agent 独立处理连接与界面。HTTP 轮询遇到短暂错误时重试当前通道，实际断线后自动重连。后台进程异常退出由 launchd 自动启动。连续约 25 个清醒运行秒内主线程或连接执行器停止推进时，Agent 会退出并交由 launchd 恢复。

## 构建和验收

打开 `FileSharingService.xcodeproj` 即可管理 App 与 Agent 源码。运行脚本重新构建 DMG 和 SHA-256 校验文件。

```bash
scripts/build-agent.sh dmg
scripts/test-local.sh
python3 tests/demo_browser.py
python3 tests/installed_agent_smoke.py
```

DMG 以无 Developer ID、无公证方式交付，App 使用 Xcode 的本地 ad-hoc 签名。构建脚本静态检查挂载后的签名和 plist。启动验收脚本在 App 拖装并打开后运行，读取 launchd 记录和本机服务端心跳，确认在指定安装路径加载当前构建并保持同一连接 60 秒。浏览器回归在隔离目录使用虚拟 Passkey 和模拟剪贴板探测。实机权限和文件操作仍由安装用户在样本目录确认。 [Apple 的本地签名说明](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes) · [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
