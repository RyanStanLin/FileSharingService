# FileSharing 生产部署

仓库是 [RyanStanLin/FileSharingService](https://github.com/RyanStanLin/FileSharingService)，`main` 分支触发 PaaS 发布。GitHub Actions 验证 React 前端及 Passkey、文件协议、WebSocket、重连和 SQLite，分别构建两个 Linux amd64 镜像，再通过受信的 GitHub OIDC 工作流按镜像 digest 发布。PR 运行检查。macOS 客户端随仓库维护。

| 服务 | 运行方式 | 入口 |
| --- | --- | --- |
| `web` | 端口 8080 上的独立 Nginx 容器，提供 React 静态资源并转发 API 和 Agent | [filesharing.ryanl.in](https://filesharing.ryanl.in/) · [`/health/ready`](https://filesharing.ryanl.in/health/ready) |
| `server` | 容器内网端口 8080 上的 ASP.NET Core 容器，内含 FTP、FTPS 和 SFTP 网关 | 公网 HTTPS 与 WSS 经前端转发，文件协议使用独立的 TCP 入口 |

`filesharing.ryanl.in` 由 Cloudflare 和 Traefik 终止 HTTPS。VPS 上的 `filesharing-ingress.service` 将此主机名的 WebSocket 和 `/agent/v1` 请求直接送到当前前端容器的回环端口，支持 Agent 的文件传输消息和 20 秒 HTTPS 长轮询。该服务还为项目后端更新 RootlessKit 的 TCP 端口映射，保留客户端源地址。后端切换时，客户端可重连。源地址和端口配置见 [`paas.json`](paas.json)。

| 协议 | 主机 | TCP 端口 |
| --- | --- | --- |
| FTP | `ftp-filesharing.ryanl.in` | 2121 |
| 显式 FTPS（AUTH TLS） | `ftp-filesharing.ryanl.in` | 2122 |
| 隐式 FTPS | `ftp-filesharing.ryanl.in` | 2990 |
| SFTP | `ftp-filesharing.ryanl.in` | 2222 |
| FTP 与 FTPS 被动数据连接 | `ftp-filesharing.ryanl.in` | 41000–41031 |

SFTP 首连时按管理页的指纹验证主机。FTPS 使用文件协议域名的独立证书，由 `filesharing-ftp-tls.timer` 每日检查续签。续签后重新启动后端装入证书。

## 密钥、更新与恢复

- GitHub Actions 仓库密钥 `PAAS_SECRETS` 提供 `FILESHARING_BOOTSTRAP_SECRET`、`FILESHARING_GATEWAY_KEY` 和 `FILESHARING_NOTIFICATION_KEY`。首次注册和恢复 Passkey 使用初始密钥。管理页右上角的 Access 提供注册入口。
- `file-data` 卷在 `/data` 保存 SQLite、归档及 SFTP 主机密钥。`ftp-tls` 卷提供文件协议的证书。普通 `main` 更新复用两卷。
- 用 GitHub Actions 的 **PaaS operations** 查看 `status`、`history` 或指定 `web` / `server` 的 `logs`。`rollback` 接收历史 release ID，恢复相应应用版本和发布配置。数据恢复通过 `backup`、`backups`、`download-backup` 和 `restore` 单独处理。普通卷备份会短暂停止写入方。
- 排查时先检查同源的 `/health/ready` 和 Actions 的部署摘要，再查看 VPS 上 `filesharing-ingress.service` 与 `filesharing-ftp-tls.service` 的日志。域名、端口及容器子网变更需要同步更新 VPS 的项目入口配置。

## macOS Release

将 Xcode 的应用版本更新后推送对应的 `vMAJOR.MINOR.PATCH` 标签。`macOS release` 构建 arm64 和 x86_64 通用 DMG，校验签名、LaunchAgent、内置 HTTPS 地址和文本文件，再把 DMG 与 SHA-256 校验文件上传到 GitHub Release。已有标签可从 Actions 手动打包。

DMG 中的 `xattr.txt` 包含 `xattr -dr com.apple.quarantine`。安装和首次打开方式见 [macOS 拖装 DMG](docs/deployment.md#macos-拖装-dmg)。

## 首次生产上线记录

2026-11-24 部署提交 `2b0707be81a73e7c58d3c08ccadf618c30cbda4d`，PaaS 发布 `4bd88e2b956f0f3beffb017a7e4044e1c67ffc9a18d8a04b5cbed67e14c4c52e`。公网通过前端静态资源、后端健康检查、Passkey 注册选项、Agent WSS、FTP 控制连接、显式及隐式 FTPS 证书和 SFTP 握手检查。 [部署工作流](https://github.com/RyanStanLin/FileSharingService/actions/runs/45424301647)

| 服务 | 首次生产镜像 digest |
| --- | --- |
| `web` | `sha256:be7e97ec127e89d682fe37d62c25b01a98c92a60756c7366735d70ed78d3b26d` |
| `server` | `sha256:7e26aa259ed690d5faec721850ac75db67fdaddba1b98045130c4825bf2722c3` |
