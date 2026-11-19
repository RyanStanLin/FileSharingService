# Milestone 1 验收记录

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
| 本机网页 Passkey、权限申请、WebSocket 状态与实际文件字节 | `test_browser_pushes_permission_and_previews_fixture_file` |
| 容器部署、测试 CA 验证、HTTPS、Agent 与浏览器 WSS、FTPS 被动数据 | `test_nginx_https_wss_and_embedded_ftps` |

## 执行结果

Agent 0.3.0 的 13 项本机集成测试和 1 项浏览器验收测试全部通过，.NET 构建为 0 警告、0 错误。挂载本机 DMG 验证了两种架构、内置 LaunchAgent、App 签名、系统默认图标、Applications 链接与启动脚本。Agent 0.2.0 的生产反向代理测试通过 1 项。0.1.0 的 NuGet 依赖审计未报告已知漏洞。0.1.0 隔离测试构建的 8 个空闲采样中，Agent CPU 峰值 0.7%，RSS 38.9–42.7 MiB。

## 复现

```bash
scripts/test-local.sh
scripts/build-agent.sh dmg
python3 tests/demo_browser.py
python3 tests/deployment_smoke.py
```

本地集成用 Python WebAuthn 虚拟凭证模拟真实签名及 RP、Origin 和用户验证检查。文件操作测试写入独立目录。稀疏文件测试验证超过 4 GiB 的逻辑偏移及对应数据。生产代理测试按测试 CA 进行真实 TLS 验证，使用独立 Compose 项目、网络、数据卷和样例证书。Xcode 构建输出 arm64 与 x86_64，挂载 DMG 检查 App 中的 SMAppService 资源和配置。

## 现场验收

实际安装时，目标用户首次打开 App，让 macOS 批准后台服务。通过网页发送 Downloads、Documents 或 Desktop 的权限申请，由本机用户在系统弹窗确认，再打开文件预览。此次自动化验收在隔离目录中完成；真实登录项注册、真实 TCC 弹窗以及重启后保活由目标 Mac 完成。 [本机联调](local-demo.md)
