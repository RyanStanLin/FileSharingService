# Milestone 1 验收记录

验证日期为 2026-11-19。开发环境为 Apple silicon macOS 27.0、Swift 6.4 工具链和 .NET SDK 10.0.401。生产 Compose 使用 .NET 10.0.15 容器。测试启动真实服务和 Swift 进程，使用工作区 `.local` 内的隔离 HOME、SQLite、证书与废纸篓。端口仅绑定回环。测试构建禁用电源改动，以隔离文件夹验证授权接口。

| Requirement | Evidence |
| --- | --- |
| 初次注册、错误密钥、重放、用户验证、来源检查、锁定、恢复与 WebSocket 撤销 | `test_passkey_bootstrap_unlock_lock_recovery` |
| 零配置接入、票据绑定、并发设备容量、持久 UUID、服务器重启、HTTPS 长轮询和设备撤销 | `test_device_zero_config_reconnect_and_long_poll` |
| 文件与文件夹元数据、大小汇总、排序、分页一致性、隐藏项与 PNG | `test_directory_metadata_sort_and_thumbnail` |
| FSEvents 本地重命名和属性/内容变化的实时推送 | `test_directory_websocket_rename_and_external_change` |
| 文件和文件夹改名、移动、废纸篓、显式永久删除、旧版本冲突与路径边界 | `test_scoped_move_trash_and_permanent_delete` |
| 范围下载、续传数据完整性、源版本保护、超范围和 64 位偏移 | `test_stream_ranges_resume_and_version_precondition` |
| 多选 ZIP、隐藏文件、空目录、相同请求重试、取消 | `test_zip_transfer_and_cancel` |
| 上传块回放、错误偏移、未完成提交拒绝与原子发布 | `test_upload_chunks_resume_and_publish` |
| FTP、显式/隐式 FTPS，后台锁定后独立登录、受保护数据连接、被动列表、REST 续传和密码轮换 | `test_ftp_ftps_locked_sessions_and_password_rotation` |
| 五项权限状态、文件夹请求、设备策略、快照刷新、历史筛选与诊断 | `test_permissions_per_device_policy_and_history` |
| 机器可读 REST 合同 | `test_openapi_contract` |
| 容器部署、测试 CA 验证、HTTPS、Agent 与浏览器 WSS、FTPS 被动数据 | `test_nginx_https_wss_and_embedded_ftps` |

## 执行结果

`scripts/test-local.sh` 的 .NET 构建为 0 警告、0 错误，11 项测试全部通过。生产反向代理测试通过 1 项。NuGet 直接和传递依赖审计未报告已知漏洞。8 个本机空闲采样中，Agent CPU 峰值 0.7%，RSS 38.9–42.7 MiB。采样使用隔离测试构建和单台设备。

## 复现

```bash
scripts/test-local.sh
scripts/build-agent.sh check
python3 tests/deployment_smoke.py
```

本地集成用 Python WebAuthn 虚拟凭证模拟真实签名及 RP、Origin 和用户验证检查。文件操作测试写入独立目录。稀疏文件测试验证超过 4 GiB 的逻辑偏移及对应数据。生产代理测试按测试 CA 进行真实 TLS 验证，使用独立 Compose 项目、网络、数据卷和样例证书。macOS 包布局检查编译 arm64 与 x86_64，构建临时未签名 PKG 并核对可执行文件、两个 launchd plist 和电源服务路径。

## 现场验收

发布需要目标设备的签名与公证、真实 Passkey 验证、Keychain 身份持久化、受管登录项目和 TCC。请在专用测试 Mac 安装签名 PKG，由本机用户处理一次 Documents、Downloads 和 Desktop 授权提示并刷新状态。随后在已登录、外接电源和电池充足的环境测试屏保、锁屏、合盖传输、断电释放和恢复正常睡眠。复核诊断与应用/存储消息，并使用组织指定版本的 FileZilla 或 Transmit 连接被动端口。用户注销和 FileVault 预启动时，由 macOS 控制用户 Agent 的可用性。

本次执行的是隔离测试。Developer ID 签名、公证、生产安装、真实 TCC、Spotlight 最近打开时间、Intel 机器执行、外接设备切换和实机合盖仍需目标环境核验。
