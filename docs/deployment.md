# 生产部署

## 服务器与 TLS

1. 选择管理端固定 HTTPS origin 和 FTP/FTPS 的内网或 VPN 地址。签发包含这些 DNS 名的证书，并准备 `fullchain.pem` 和 `privkey.pem`。FTPS 校验链需要完整的中间证书，客户端应验证主机名和 CA。
2. 在部署目录运行 `./init-env.sh`，随机生成 256 位 `FILESHARING_BOOTSTRAP_SECRET` 并以 `0600` 保存到 `deploy/.env`。通过内部密钥交付渠道把密钥交给管理员。首次注册和重置 Passkey 都需要它。更换恢复密钥时更新 `.env` 并重建服务容器。
3. 设置以下变量。证书目录挂载在 Nginx 和服务容器中，赋予运行服务的容器用户读取权限。运行 `docker compose run --rm --no-deps --entrypoint id server` 可核对实际 UID。将数据卷放在主机加密存储，备份和恢复时同时处理 SQLite 与归档。
4. 运行 `docker compose up -d --build`。外部测试 `GET https://管理域名/health/ready`。管理端接入前端时让它与 API 同源，保持浏览器 WebAuthn RP ID 和 origin 固定。

| 设置 | 用途 |
| --- | --- |
| `FILESHARING_DOMAIN`、`FILESHARING_ORIGIN` | Nginx 主机名及精确浏览器 HTTPS origin。更改 RP ID 后重新登记 Passkey。 |
| `FILESHARING_HTTPS_IP`、`FILESHARING_HTTPS_PORT` | HTTPS 的发布地址和端口。示例绑定到回环。常规站点使用端口 443。 |
| `FILESHARING_NETWORK_PREFIX` | Compose 专用 IPv4 子网前三段。代理固定在 `.10`，服务固定在 `.20`。 |
| `FILESHARING_MAX_DEVICES` | 活跃登记设备数上限，默认 100。 |
| `FILESHARING_FTP_IP`、`FILESHARING_FTP_HOST` | TCP 入口内网 IP 和对客户端公布的名字。 |
| `FILESHARING_FTP_PLAIN_PORT`、`FILESHARING_FTP_EXPLICIT_PORT`、`FILESHARING_FTP_IMPLICIT_PORT` | 明文 FTP、显式 FTPS 和隐式 FTPS，示例为 2121、2122、2990。 |
| `FILESHARING_FTP_PASSIVE_MIN/MAX/ADDRESS` | PASV/EPSV 共享端口范围及 PASV 公布的 IPv4 地址。 |
| `FILESHARING_FTP_PLAIN_CLIENTS` | 明文监听器允许的客户端 CIDR，逗号分隔。使用组织私网或 VPN 的访问控制。 |
| `FILESHARING_TLS_DIR` | 证书目录。新证书就绪后重建或重启服务及 Nginx，再验证两种 TLS 入口。 |

DNS/证书续期由部署环境维护。生产反向代理覆盖 `Host`、`X-Forwarded-Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。仅将直接上游代理 IP 加到 `FileSharing__KnownProxies`。Nginx 模板还转发 WebSocket Upgrade 并关闭流量缓冲。Caddy 可以用 `reverse_proxy` 保持这些头部和升级语义。Kestrel 的 HTTP 端口仅留在容器网络。

将 FTP/FTPS 控制端口与整个被动端口范围逐端口做 TCP 映射，被动端口必须一一对应并从同一客户端 IP 可达。显式 FTPS 使用 `AUTH TLS` 与 `PROT P`。传统 FTP 数据及账号密码是明文，部署在专用网络入口和受限 CIDR。优先采用保留来源 IP 的 DNAT。代理重写来源 IP 时将实际访问控制落实在入口防火墙。部署配置示例为 [compose.yaml](../deploy/compose.yaml) 和 [nginx.conf.template](../deploy/nginx.conf.template)。标准见 [RFC 4217](https://www.rfc-editor.org/info/rfc4217/) 与 [RFC 3659](https://www.rfc-editor.org/info/rfc3659/)。

## macOS 企业打包

1. 为目标设备准备一个企业受管 macOS 15 或以上用户并确认短用户名。解锁管理会话后调用 `POST /api/v1/enrollments` 生成对应的一次性票据，把单个 `code` 写入权限 `0600` 的构建输入文件。已有设备升级时要保留原有本地状态和签名身份。给票据预留公证与分发时间。
2. 在具备 Developer ID 证书的 Mac 构建。设置 `FILESHARING_ORIGIN`、`FILESHARING_MANAGED_USER`、`FILESHARING_ACTIVATION_FILE`、`FILESHARING_DEVELOPER_ID_APPLICATION`、`FILESHARING_DEVELOPER_ID_INSTALLER`、`FILESHARING_NOTARY_PROFILE`。需要允许写入该用户 HOME 的部署显式设置 `FILESHARING_ALLOW_HOME_WRITE=1`，其他部署默认只读。
3. 运行 `scripts/build-agent.sh package`。脚本生成 arm64 / x86_64 Universal 2、Hardened Runtime 签名、签名 PKG、Apple 公证及 stapling。一个设备票据对应一个包。后台端点编译进二进制，后续连接使用 Keychain 的设备身份。可选备份端点应转发到同一 FileSharing 实例，保持后端校验的 Host。
4. 通过企业 MDM 静默分发签名 PKG，并用受管登录项目策略批准 FileSharing 的 LaunchAgent 和 LaunchDaemon。FileSharing 以 `/Applications/FileSharingAgent.app` 的无界面后台可执行文件运行。macOS 在目标用户登录后启动该程序，安装脚本对已经登录的用户启动或重启对应服务。软件包的电源辅助进程采用系统 LaunchDaemon，且仅读取目标用户的有限租约。仅在已授权目标上运行 `sudo installer -pkg <pkg-path> -target /` 作为 MDM 的同等安装入口。
5. 用 MDM 的 PPPC 或目标用户在系统提示中处理 Desktop、Documents、Downloads 权限。签名主体、bundle ID 和代码要求要与 PPPC 配置一致。按需将额外企业目录交给 Agent 的 `roots add read|write /absolute/path` 命令，重启用户 Agent，再由管理员在 `file-roots` 中授权。空路径从 HOME 授权根开始。

MDM 应独立设置屏保超时与锁屏密码，并在目标机型验证合盖工作。电源服务采用 AC、电池、温度和短租约门槛。开启后通过设备 `power` 样本核对 `closedLid.state` 为 `active`、`sleepDisabled` 为真并在合盖后验证实时文件传输。主动关闭策略或断开电源后应观测到释放。卸载前先关闭对应设备策略并确认恢复再卸载 LaunchDaemon。参考 [Apple 的 LaunchAgent 与 LaunchDaemon 模型](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html) 与 [Apple 设备管理 PPPC 服务列表](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services-data.dictionary)。

## 服务验收和备份

- 管理域名验证证书、Passkey 建立和重置、关闭管理会话后 HTTP 受限及 WSS 退出。
- 连接内网 FTP 和 FTPS，下载到测试目录并计算哈希。打开目录订阅后在 Mac 的测试目录内手工重命名文件，检查客户端推送。
- 定期对 SQLite 做在线一致性备份，例如 SQLite 的 `.backup` 命令。停止服务后迁移整个持久卷也可获得一致状态。滚动升级提前备份并复测登录和传输，单实例重启待设备重新连接后继续已登记的单文件传输。
- 发布前使用 `scripts/test-local.sh` 运行本机验收，通过 `scripts/build-agent.sh check` 编译两种架构。需要真实 TCC、锁屏和合盖试验时使用专门受管测试 Mac。
