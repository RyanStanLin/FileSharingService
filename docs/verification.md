# FileSharing 验收记录

## Agent 0.5.1

`submitsConfiguredTextFields` 在原生 NSAlert 中核对 260 pt 宽度、多个输入框的提示与预填、禁用状态、遮蔽、必填校验及按字段回传。原生回归同时覆盖居中、默认选项、Escape、超时和再次弹出。

`test_dialog_response_notification_and_session_cancellation` 覆盖 WSS、HTTPS 回退、请求及答复校验和仅提供作业状态的 WS 事件。`test_dialog_helper_crash_and_timeout_preserve_connection` 验证六个满长度字段通过双向管道，故障或超时后设备连接继续工作。`test_browser_configures_dialog_text_fields` 验证 Demo 的添加、移除、配置和逐字段结果遮蔽。

## Milestone 3 · Agent 0.5.0

使用 `scripts/test-local.sh` 运行集成套件。测试启动独立回环服务器、SQLite 数据库以及可控的 Bark 和 Telegram 服务，并使用隔离目录运行真实的 macOS Agent。通知测试覆盖如下。

| 场景 | 集成测试 |
| --- | --- |
| 渠道 CRUD、Bot 身份与聊天核验、凭据脱敏、测试幂等、429 跨重启重试及 WebSocket 回放 | `test_notification_destinations_and_durable_delivery` |
| 多事件及多渠道、过滤、模板预览、去重、冷却、电量阈值、休眠和合盖事件 | `test_notification_rules_match_trusted_events_and_render_context` |
| WSS 离线、HTTPS 恢复、绑定安装凭据和隔离未获信连接 | `test_notification_presence_requires_bound_agent_identity` |
| 真实新增、修改、重命名、移除、目录批次、授权范围和会话锁定期间的投递 | `test_notification_file_watches_apply_scope_and_run_while_locked` |
| 真实 Agent 的 HTTPS 文件事件及撤销根后取消重试 | `test_notification_directory_watch_delivers_over_https` |
| 快速重新授权后拒收旧目录租约的消息 | `test_notification_file_watch_rejects_stale_frames_after_reauthorization` |

生产部署前，把实际 Bark 设备 Key 或 Telegram Bot Token 配到目标服务，并调用测试投递确认收到消息。实体合盖、睡眠和唤醒需要在目标 Mac 验收。 [通知配置与请求示例](notifications.md)

## Agent 0.4.8

`test_window_geometry_focus_and_live_fallback` 使用同一份窗口采集逻辑和隔离输入，验证多屏相对坐标、大小、前后顺序、透明窗处理、部分和完全遮挡。还验证同一 Foreground 应用中的焦点判定、仅 Foreground 切换时的更新，以及前台应用没有屏上窗口的情形。Agent 分别使用 WebSocket 和 HTTPS，浏览器 WebSocket 与 REST 长轮询接收同一修订。撤销连接授权后窗口订阅结束，数据库中无窗口快照和历史事件。

本机 WindowServer 验收在双屏会话读取实际窗口数据。临时 AppKit 测试窗口的创建、移动、缩放和所属进程退出均产生了 WebSocket 快照。原生采集将现有 Foreground 应用最靠前的屏上窗口标为焦点。

## Agent 0.4.7

`test_folder_permission_enables_scoped_writes_and_library_reads` 在 WebSocket 和 HTTPS 回退下验证只读 HOME。一次 Downloads 授权后，新建目录、上传、改名和移动通过。带隐藏标志的 `~/Library` 可浏览和下载，移入 Library 被拒绝。重启保留新版目录授权，旧版 Documents 授权在新版 Agent 检查可写后生效。

本机由 0.4.6 升级到 0.4.7 后，Downloads、Documents 和 Desktop 三项既有目录授权均由已安装的 Agent 确认可写。网页通过隔离设备和虚拟 Passkey 验证按钮行为。申请前写操作停用。一次授权后，Downloads 的新建和上传可用。进入 Library 后写操作停用。

## Agent 0.4.6

`submitsPlainTextAndSelectedOption` 在 macOS 27.0 上核对只有「同意」「暂缓」两个按钮，两者同一行，默认按钮位于右侧。单选、遮蔽输入、Escape、超时及重开也通过原生 AppKit 回归。

## Agent 0.4.5

原生 AppKit 测试核对弹窗与屏幕的水平和垂直中心，再通过 `submitsOnlyVisibleChoice` 验证单选请求只有一个可见按钮且能提交。`dismissesWithEscapeWhileEditing` 验证单选弹窗里的遮蔽输入可使用 Escape 关闭。短内容样例实测宽度仍为 260 pt。

## Agent 0.4.4

`tests/native_dialog_smoke.swift` 在已解锁的 Mac 上验证了独立的 AppKit `NSAlert`、当前空间置顶、应用图标和首选项默认按钮。短内容实测宽度为 260 pt。普通说明和 `NSSecureTextField` 遮蔽审批码均可提交，审批码保留前导零和空格。取消、Escape、请求撤销及超时后重新弹出均通过。

`test_dialog_response_notification_and_session_cancellation` 和 `test_dialog_helper_crash_and_timeout_preserve_connection` 通过，覆盖 WebSocket、HTTPS 回退及弹窗进程回收。锁屏时，安装包中的弹窗进程在两种传输下均返回 `interactive_session_required`，同一连接继续更新心跳。双架构 DMG 通过签名和 SHA-256 校验，本机安装后 LaunchAgent 在同一进程和连接上稳定运行并持续更新心跳。

## Agent 0.4.3

原生弹窗验收确认 260 pt 面板的审批码输入使用 `NSSecureTextField`，带前导零和空格的测试值按原样回传。设备 WebSocket 与 HTTP 回退的交互契约、弹窗进程恢复及 4 项浏览器回归通过。Demo 在收到审批码后默认遮蔽显示，并支持查看与重新遮蔽。

## Agent 0.4.2

26 项集成测试及 4 项浏览器回归通过。.NET 的 Debug 和 Release 构建各报告 0 个警告和 0 个错误。

已安装的 Agent 0.4.2 在本机联调重新上线。强制终止该进程后，launchd 在约 3.2 秒内启动了新进程并重新连上服务，随后心跳持续推进。AppKit 测试测量单个原生面板的 260 pt 宽度，并验证置顶、应用图标、默认选项、提交及关闭。安装包内实际运行的弹窗进程也验证了超时退出。双架构 DMG 与内置 App 通过校验，应用资源包含用户提供的 Icon Composer 图标。

| 验收项 | 对应用例 |
| --- | --- |
| 弹窗进程失败或超时可回收，下一次弹窗和同一设备连接继续工作 | `test_dialog_helper_crash_and_timeout_preserve_connection` |
| WSS 服务重启及切换 HTTPS 回退后原 Agent 进程自动重连 | `test_running_agent_recovers_when_server_restarts` |
| HTTPS 单次 503 后重试成功，保留通道和连接授权 | `test_http_polling_retains_connection_after_a_transient_frame_error` |
| 主线程卡在启动阶段时 watchdog 退出进程 | `test_agent_watchdog_exits_a_blocked_startup` |
| 系统验证的结果契约与额外字段拒绝 | `test_dialog_response_notification_and_session_cancellation` |

## 本机 FTP 客户端兼容性

`test_loopback_ftp_active_listing_and_protected_download` 验证 `PORT` 和 `EPRT` 列表、显式及隐式 FTPS 主动下载，拒绝与控制连接不同的目标 IP 和特权端口，并验证被动模式与 `EPSV ALL`。22 项集成测试和 Demo 网关浏览器回归通过。在 macOS 27.0 上用系统 `mount_ftp` 和隔离测试账号挂载 `localhost`、`127.0.0.1` 上的 FTP 根并读取同一文件。没有已授权设备时，同一地址依然可挂载，目录为空。

连续读取时，macOS 可能为每个文件建立新的 FTP 控制连接。修复前，原生挂载连续复制 14 个文件后因登录限额出现 I/O 错误。修复后，分别通过 `localhost` 和 `127.0.0.1` 成功复制 24 个文件，并逐字节核对内容，包含以 `#` 开头的 SVG。写入测试返回 `EROFS`。`test_ftp_repeated_valid_logins_preserve_ip_limit` 验证重复合法登录和未知凭证限流。`test_ftp_cached_login_respects_account_lock_and_password_rotation` 验证账号锁定和密码轮换。

## Agent 0.4.1

21 项集成测试和 4 项浏览器回归通过。原生 AppKit 测试在已登录的 macOS 图形会话验证窗口层级、当前空间、默认按钮、必填说明及回传。本机已安装的 0.4.1 从 LaunchAgent 上线，同一进程及连接连续运行 30 秒。安装前的 HOME 记录保存了旧装载编号，升级后迁移出卷 UUID，原有根标识继续匹配服务器授权。双架构 DMG 通过签名和 SHA-256 校验。

| 验收项 | 对应用例 |
| --- | --- |
| 装载编号变化后通过 HTTP 与 FTP 列出 HOME 内容，卷 UUID 不符时拒绝访问 | `test_home_volume_identity_recovers_directory_and_ftp_listings` |
| 自定义命令在 WSS 和 HTTPS 回退下回传输出及退出码，REST 可补读 | `test_diagnostic_outputs_stream_and_resume_on_wss_and_https` |
| Demo 输入自定义命令后显示输出并报告退出码 | `test_browser_saves_power_policy_collects_samples_and_rotates_ftp_credentials` |
| 原生弹窗置顶、请求标题及正文、首按钮及说明框 | `tests/native_dialog_smoke.swift` |

## Milestone 2 · Agent 0.4.0

验证环境为 Apple silicon Mac、.NET 10、Go 1.27、Xcode 和 Docker Compose。集成用例启动隔离的真实服务及 Swift Agent，Passkey 使用测试凭证。

`scripts/test-local.sh` 的 20 项集成测试全部通过，.NET 构建有 0 个警告和 0 个错误。2 项浏览器回归、1 项 Compose 部署烟测和原生 AppKit 对话框测试通过。双架构 DMG 通过签名、plist、SHA-256 和镜像校验。Go 模块通过校验与 `go vet`，AsyncAPI 3 文档通过解析检查。

| Requirement | Evidence |
| --- | --- |
| 真实诊断输出、WSS 退出码、HTTPS 回退和 REST 游标 | `test_diagnostic_outputs_stream_and_resume_on_wss_and_https` |
| STDERR 在退出前持久化、重传去重、非零退出码 | `test_stderr_progress_precedes_exit_and_duplicate_is_ignored` |
| 原生对话框显示、必填原因校验、选项与文本 | `tests/native_dialog_smoke.swift` |
| 对话框答复、通知作业、锁定时取消及两种传输 | `test_dialog_response_notification_and_session_cancellation` |
| 剪贴板时间、拒收额外字段、合盖状态模拟、实时 RTT 与 REST 重放 | `test_clipboard_timestamp_lid_and_heartbeat_over_both_transports` |
| 原生 App 启停事件、安装清单变化与图标哈希 | `test_application_inventory_icon_hash_and_native_lifecycle` |
| 两台已授权设备的主目录、实时会话、独立加密密码和新鲜 Passkey 核验 | `test_gateway_live_home_scope_connections_and_encrypted_password_reveal` |
| OpenSSH 目录分页、字节一致性、只读边界、旧会话撤销、主机密钥持久化 | `test_sftp_home_paging_download_password_revocation_and_host_key` |
| Linux 容器、HTTPS 与两侧 WSS、FTPS 和 SFTP | `test_nginx_https_wss_ftps_and_sftp` |
| 历史库迁移后保留设备、账号及根授权 | `test_sqlite_upgrade_preserves_preexisting_device_and_grant` |

在登录到 Aqua 的 Mac 上可以用以下命令验收 AppKit 对话框。测试程序检查独立弹窗、层级、应用图标、默认按钮及原生遮蔽输入，输出原生宽度，并验证提交、取消、超时及再次弹出。

```bash
mkdir -p .local
swiftc -swift-version 5 -parse-as-library -D FILESHARING_APP \
  src/Mac/NativeDialog.swift src/Mac/DialogProcess.swift src/Mac/JSON.swift tests/native_dialog_smoke.swift \
  -o .local/native-dialog-smoke
.local/native-dialog-smoke
```

发布前的现场验收包括目标 Mac 的通知授权和横幅、实体 USB/SD 事件、真实合盖唤醒及安装后的 LaunchAgent 持续运行。客户端本机调试包连接 `http://localhost:8847`，部署包构建时填写管理服务的 HTTPS 地址。

## Milestone 1

本机 DMG 与浏览器测试的验证日期为 2026-11-20。开发环境为 Apple silicon macOS 27.0、Swift 6.4 工具链和 .NET SDK 10.0.401。生产 Compose 使用 .NET 10.0.15 容器。测试启动真实服务和 Swift 进程，使用工作区 `.local` 内的隔离 HOME、SQLite、证书与废纸篓。端口仅绑定回环。测试构建禁用电源改动，以隔离文件夹验证授权接口。

| Requirement | Evidence |
| --- | --- |
| 初次注册、错误密钥、重放、用户验证、来源检查、锁定、恢复与 WebSocket 撤销 | `test_passkey_bootstrap_unlock_lock_recovery` |
| 公网零配置登记、重复 UUID 隔离、按连接授权、并发设备容量、持久 UUID、HTTPS 长轮询和设备撤销 | `test_device_zero_config_reconnect_and_long_poll` |
| 文件与文件夹元数据、大小汇总、排序、分页一致性、隐藏项与 PNG | `test_directory_metadata_sort_and_thumbnail` |
| FSEvents 本地重命名和属性/内容变化的实时推送 | `test_directory_websocket_rename_and_external_change` |
| 文件和文件夹改名、移动、废纸篓、显式永久删除、旧版本冲突与路径边界 | `test_scoped_move_trash_and_permanent_delete` |
| 范围下载、续传数据完整性、源版本保护、超范围和 64 位偏移 | `test_stream_ranges_resume_and_version_precondition` |
| 多选 ZIP、隐藏文件、空目录、相同请求重试、取消 | `test_zip_transfer_and_cancel` |
| 上传块回放、错误偏移、未完成提交拒绝与原子发布 | `test_upload_chunks_resume_and_publish` |
| FTP、显式/隐式 FTPS，后台锁定后独立登录、受保护数据连接、被动列表、REST 续传和密码轮换 | `test_ftp_ftps_locked_sessions_and_password_rotation` |
| 五项权限状态、文件夹请求、设备策略、快照刷新、历史筛选与诊断 | `test_permissions_per_device_policy_and_history` |
| 初始后台尚未配置时公网设备也能登记上线 | `test_public_admission_before_admin_registration` |
| 旧 SQLite 设备、别名和根授权可迁移 | `test_sqlite_upgrade_preserves_preexisting_device_and_grant` |
| 机器可读 REST 合同 | `test_openapi_contract` |
| 本机网页 Passkey、剪贴板等待期间的设备长轮询、文件夹权限、WebSocket 回报与实际文件字节 | `test_browser_reports_pending_pasteboard_and_previews_file_over_polling` |
| 本机网页实际 PNG 缩略图、扩展名和时间字段、排序翻页、隐藏项与锁定后清空列表 | `test_browser_renders_thumbnails_and_sorts_file_metadata_across_pages` |
| 已安装 App 的 launchd 构建版本、实际可执行路径和持续心跳 | `tests/installed_agent_smoke.py` |
| 容器部署、测试 CA 验证、HTTPS、Agent 与浏览器 WSS、FTPS 被动数据 | `test_nginx_https_wss_and_embedded_ftps` |

## 执行结果

Agent 0.3.1 的 13 项本机集成测试和 1 项浏览器回归通过，.NET 构建为 0 警告、0 错误。挂载本机 DMG 验证了两种架构、内置 LaunchAgent、App 签名、系统默认图标、Applications 链接与启动脚本。Agent 0.2.0 的生产反向代理测试通过 1 项。0.1.0 的 NuGet 依赖审计未报告已知漏洞。0.1.0 隔离测试构建的 8 个空闲采样中，Agent CPU 峰值 0.7%，RSS 38.9–42.7 MiB。

0.3.0 实机安装后曾出现启动超过两分钟才发起首个 WebSocket 尝试。长轮询上线后，应用遥测占用主线程，导致失去心跳并使权限任务以 `device_unavailable` 结束。0.3.1 将应用扫描移到工作队列，让轮询心跳在权限探测等待期间继续运行。浏览器回归在剪贴板探测未返回时完成下载目录权限申请和预览，释放模拟探测后检查任务结果及连接 ID。

0.3.1 的打包验收曾从临时挂载路径执行同标识 App。实机的 launchd 随后从已卸载的镜像路径启动旧注册，因找不到文件以 `EX_CONFIG` 结束。0.3.2 改为只通过静态方式校验镜像，并在安装目录内首次打开时刷新旧构建的注册。重新打包前后核对了原有 launchd 记录。

安装后的 0.3.2 通过了同一进程与连接持续 60 秒的实机检查。文件列表更新通过 13 项集成测试与 2 项浏览器回归，其中缩略图测试对浏览器解码后的像素进行了核对。

## 复现

```bash
scripts/test-local.sh
scripts/build-agent.sh dmg
python3 tests/demo_browser.py
python3 tests/deployment_smoke.py
python3 tests/installed_agent_smoke.py
```

本地集成用 Python WebAuthn 虚拟凭证模拟真实签名及 RP、Origin 和用户验证检查。文件操作测试写入独立目录。稀疏文件测试验证超过 4 GiB 的逻辑偏移及对应数据。生产代理测试按测试 CA 进行真实 TLS 验证，使用独立 Compose 项目、网络、数据卷和样例证书。Xcode 构建输出 arm64 与 x86_64，挂载 DMG 检查 App 中的 SMAppService 资源和配置。

## 现场验收

首次打开或升级 App 后，运行 `tests/installed_agent_smoke.py` 检查实际进程版本、安装路径，以及同一连接上的 60 秒心跳。等待上线后复制一段测试文本，检查事件载荷只有 `occurredAt`，然后在授权的 Downloads、Documents 或 Desktop 打开样本文件预览。最后验证退出网页、锁屏及再次登录后的连接状态。 [本机联调](local-demo.md)
