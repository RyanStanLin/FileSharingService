# 生产部署

## 服务器与 TLS

1. 选择公网可达的 HTTPS origin 和 FTP/FTPS 的内网或 VPN 地址。签发包含这些 DNS 名的证书，并准备 `fullchain.pem` 和 `privkey.pem`。FTPS 校验链需要完整的中间证书，客户端应验证主机名和 CA。
2. 在部署目录运行 `./init-env.sh`，随机生成 256 位 `FILESHARING_BOOTSTRAP_SECRET` 并以 `0600` 保存到 `deploy/.env`。通过内部密钥交付渠道把密钥交给管理员。首次注册和重置 Passkey 都需要它。更换恢复密钥时更新 `.env` 并重建服务容器。
3. 设置以下变量。证书目录挂载在 Nginx 和服务容器中，赋予运行服务的容器用户读取权限。运行 `docker compose run --rm --no-deps --entrypoint id server` 可核对实际 UID。将数据卷放在主机加密存储，备份和恢复时同时处理 SQLite 与归档。
4. 运行 `docker compose up -d --build`。外部测试 `GET https://管理域名/health/ready`。管理端接入前端时让它与 API 同源，保持浏览器 WebAuthn RP ID 和 origin 固定。公网 HTTPS 同时提供 Agent 自动登记。

| 设置 | 用途 |
| --- | --- |
| `FILESHARING_DOMAIN`、`FILESHARING_ORIGIN` | Nginx 主机名及精确浏览器 HTTPS origin。更改 RP ID 后重新登记 Passkey。 |
| `FILESHARING_HTTPS_IP`、`FILESHARING_HTTPS_PORT` | HTTPS 的发布地址和端口。公网部署可以绑定主机公网 IP 或 `0.0.0.0`。常规站点使用端口 443。 |
| `FILESHARING_NETWORK_PREFIX` | Compose 专用 IPv4 子网前三段。代理固定在 `.10`，服务固定在 `.20`。 |
| `FILESHARING_MAX_DEVICES` | 活跃登记设备数上限，默认 100。 |
| `FILESHARING_FTP_IP`、`FILESHARING_FTP_HOST` | TCP 入口内网 IP 和对客户端公布的名字。 |
| `FILESHARING_FTP_PLAIN_PORT`、`FILESHARING_FTP_EXPLICIT_PORT`、`FILESHARING_FTP_IMPLICIT_PORT` | 明文 FTP、显式 FTPS 和隐式 FTPS，示例为 2121、2122、2990。 |
| `FILESHARING_FTP_PASSIVE_MIN/MAX/ADDRESS` | PASV/EPSV 共享端口范围及 PASV 公布的 IPv4 地址。 |
| `FILESHARING_FTP_PLAIN_CLIENTS` | 明文监听器允许的客户端 CIDR，逗号分隔。使用组织私网或 VPN 的访问控制。 |
| `FILESHARING_TLS_DIR` | 证书目录。新证书就绪后重建或重启服务及 Nginx，再验证两种 TLS 入口。 |
| `FILESHARING_GATEWAY_KEY` | 可选。由 `openssl rand -hex 32` 单独生成，用于加密供管理员查看的网关密码。与数据库备份分开保管。 |

DNS/证书续期由部署环境维护。生产反向代理覆盖 `Host`、`X-Forwarded-Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。仅将直接上游代理 IP 加到 `FileSharing__KnownProxies`。Nginx 模板还转发 WebSocket Upgrade 并关闭流量缓冲。Caddy 可以用 `reverse_proxy` 保持这些头部和升级语义。Kestrel 的 HTTP 端口仅留在容器网络。

将 FTP/FTPS 控制端口与整个被动端口范围逐端口做 TCP 映射，被动端口必须一一对应并从同一客户端 IP 可达。显式 FTPS 使用 `AUTH TLS` 与 `PROT P`。传统 FTP 数据及账号密码是明文，部署在专用网络入口和受限 CIDR。优先采用保留来源 IP 的 DNAT。代理重写来源 IP 时将实际访问控制落实在入口防火墙。部署配置示例为 [compose.yaml](../deploy/compose.yaml) 和 [nginx.conf.template](../deploy/nginx.conf.template)。标准见 [RFC 4217](https://www.rfc-editor.org/info/rfc4217/) 与 [RFC 3659](https://www.rfc-editor.org/info/rfc3659/)。

## macOS 拖装 DMG

在 Xcode 打开 `FileSharingService.xcodeproj`。App 和后台进程共用一个 App bundle，内置 LaunchAgent 由 `SMAppService` 在首次打开时注册。

- 用 `FILESHARING_ORIGIN=https://filesharing.example.com scripts/build-agent.sh dmg` 构建部署包。产物位于 `artifacts`。可选的 `FILESHARING_MANAGED_USER` 限定登录账户，远程部署可用 `FILESHARING_ALLOW_HOME_WRITE=YES` 允许 HOME 写入。
- 打开 DMG，把 App 拖入 Applications，再打开已安装的 App。首次打开遵照 macOS 的单 App 放行流程。包内的启动脚本打开已安装 App。
- 从 `/Applications/FileSharingService.app` 首次打开会通过 Service Management 注册内置 LaunchAgent。App 记录当前构建的指纹并在升级后首次打开时刷新注册。按系统提示在「登录项与扩展」允许后台运行。此后由 launchd 管理登录启动和异常重启。用户可再次打开 App 查看注册状态或停用服务。
- Agent 上线后，选择当前设备连接开启远程文件操作。Desktop、Documents 和 Downloads 由用户在 macOS 的授权弹窗或系统设置中处理。若需新增企业目录，在受管用户进程调用 App 内的 `roots add read|write /absolute/path`，重启后台服务后在管理端授权。
- DMG 采用本地 ad-hoc 签名的非公证 App，并内置用户 LaunchAgent。仓库中的特权电源辅助代码独立于这份拖装包。文件联调用默认本机地址时，Agent 保持只读并关闭电源修改。 [Apple 的首次打开说明](https://support.apple.com/en-us/102445) · [Apple 的内置 LaunchAgent 布局](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)

## 从早期设备协议升级

先备份 SQLite，再同步升级服务与 Agent。数据库在启动时迁移并保留设备 UUID、别名、目录授权、历史及管理员 Passkey。Agent 使用早期版本的本机 `enrollment.json` 继续识别已登记的设备。新协议使用 WSS hello 或公开的 HTTPS connect 接口。升级后，在新连接上重新开启远程操作。恢复旧版时使用升级前的数据库备份。

## 服务验收和备份

- 管理域名验证证书、Passkey 建立和重置、关闭管理会话后 HTTP 受限及 WSS 退出。
- 连接内网 FTP 和 FTPS，下载到测试目录并计算哈希。打开目录订阅后在 Mac 的测试目录内手工重命名文件，检查客户端推送。
- 定期对 SQLite 做在线一致性备份，例如 SQLite 的 `.backup` 命令。停止服务后迁移整个持久卷也可获得一致状态。滚动升级提前备份并复测登录和传输，单实例重启待设备重新连接后继续已登记的单文件传输。
- 使用 `scripts/test-local.sh` 运行集成测试，通过 `scripts/build-agent.sh dmg` 编译两种架构并静态检查镜像。使用本机测试包安装或升级后，运行 `python3 tests/installed_agent_smoke.py` 验证实际的 launchd 启动和心跳，并在目标 Mac 检查 TCC 流程。
