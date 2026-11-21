# FileSharing

FileSharing 是面向企业 macOS 设备的内部文件访问与管理服务。ASP.NET Core 10 LTS 承载 Passkey 管理 API、事件订阅和 FTP/FTPS/SFTP 文件网关。Swift Agent 在受管用户会话内运行，支持设备遥测、只读诊断、原生对话框和本地通知。

Agent 的网络配置只需服务端 HTTPS 地址。公网客户端首次连上即可自动登记，重连沿用本机 UUID。设备上线后，管理员可以为当前连接开启远程文件和管理操作。

本机试用使用 `scripts/demo-server.sh start` 和 `scripts/build-agent.sh dmg`。把 DMG 中的 App 拖进 Applications 后打开，网页会显示在线设备、权限状态和实际文件内容。 [本机联调步骤](docs/local-demo.md)

| 交付物 | 入口 |
| --- | --- |
| 架构与协议 | [docs/architecture.md](docs/architecture.md) |
| File System Web（Milestone 1） | [web/README.md](web/README.md) |
| 前端 API 与 WebSocket | [docs/api.md](docs/api.md) · [FileSharing.http](FileSharing.http) |
| ASP.NET Core 服务端 | [src/Server/Program.cs](src/Server/Program.cs) |
| macOS Agent 与电源服务 | [src/Mac/Main.swift](src/Mac/Main.swift) · [src/Power/Main.swift](src/Power/Main.swift) |
| 部署、签名与验收 | [docs/deployment.md](docs/deployment.md) · [docs/verification.md](docs/verification.md) |

在开发 Mac 上运行隔离验收需要 .NET 10 SDK、Go 1.26+、Xcode Command Line Tools、OpenSSH、OpenSSL 和 Python 3。可在仓库内建立测试虚拟环境。测试启动实际服务端和 Agent，所有测试目录、凭据和废纸篓均位于仓库的 `.local`。构建产物位于 `artifacts`。

```bash
python3 -m venv .local/test-env
source .local/test-env/bin/activate
python3 -m pip install -r tests/requirements.txt
scripts/test-local.sh
```

需要验证生产反向代理时，先构建隔离 Agent，再运行 `python3 tests/deployment_smoke.py`。该测试使用临时 Docker Compose 项目和测试证书。

应用、存储与设备样本字段见 [docs/telemetry.md](docs/telemetry.md)，浏览器 WebSocket 消息契约见 [docs/asyncapi.yaml](docs/asyncapi.yaml)。
