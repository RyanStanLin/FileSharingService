# FileSharing Milestone 1 架构

## 拓扑

```mermaid
flowchart LR
    Browser["管理前端"] -->|"HTTPS + WSS / Passkey 会话"| Proxy["Nginx"]
    Proxy -->|"可信转发头"| Server["ASP.NET Core 10"]
    FTP["FileZilla / Transmit"] -->|"FTP / FTPS 控制与被动数据 TCP"| Server
    Server -->|"WAL"| DB["SQLite"]
    Server -->|"归档暂存与成品"| Files["受保护持久卷"]
    Agent["受管账户 Swift LaunchAgent"] -->|"外向 WSS / HTTPS 长轮询"| Proxy
    Agent -->|"文件描述符与 FSEvents"| Home["HOME 与批准的目录"]
    Agent -->|"短时本地租约"| Power["专用电源 LaunchDaemon"]
    Power -->|"固定 pmset 操作与电源策略"| OS["macOS"]
```

服务端按身份认证、终端连接、设备策略、文件授权与操作、传输、事件、FTP 监听器分层。SQLite 单实例事务保护设备容量、Passkey 更新、文件授权、账号版本和任务元数据。FTPS 监听器随 ASP.NET Core 进程启动，与 REST 处理器共享目录授权和数据中继。

## 身份与授权

| 主体 | 身份 | 授权 |
| --- | --- | --- |
| 管理员 | 使用部署随机密钥首次注册单一 Passkey。验证用户在场和本机用户验证后签发 HttpOnly 会话。 | 会话空闲 30 分钟、绝对 8 小时。上锁撤销当前会话，恢复 Passkey 原子替换凭证并撤销所有管理会话。 |
| Mac | IT 为一台设备签发有期限的一次性票据。安装包内嵌该票据和 HTTPS 地址。Agent 保存 UUID 及 P-256 设备密钥。 | 服务器签发短期 Bearer，注销后拒绝设备认证和文件访问。并发登记容量由部署配置决定。 |
| FTP 客户端 | 独立账号、加盐 PBKDF2 口令和专用监听模式。 | 每个账号显式选择已授权的根，按账号修订号核验。后台锁定期间继续工作。 |

默认共享根是受管用户 HOME，由 Agent 在首次接入声明、服务端创建一次。受管包可以在构建时批准 HOME 写入。额外企业目录由 IT 在本机设定、管理端授予访问。设备端强制本地范围与读写上限，服务端在每次文件请求和每个下载块重新验证根授权。HOME 系统隐私目录、常见凭据目录和 Agent 工作区从列表中排除，受保护 macOS 文件夹按真实文件系统权限与 TCC 状态访问。

Agent 使用 `openat`、`fstatat`、`renameatx_np` 和 `unlinkat` 逐级处理路径，校验根 inode 和设备号，拒绝穿越 symlink 和跨挂载点递归，拒绝读取硬链接目标。写操作使用客户端先前取得的版本防止误改，移动默认不覆盖。永久清除非空目录需要显式递归标志。文件操作请求、完成、设备接入和权限变更保留审计。

## 通信协议

1. Agent 调用 `POST /agent/v1/activate`，发送 `code`、`name` 和 Base64URL P-256 X9.63 公钥。票据只允许同一公钥的幂等重试。
2. 请求 `POST /agent/v1/challenge`，提交 `{deviceId}`。使用 ES256 对 `FileSharing agent session v1\n<UUID>\n<challenge>` 的 UTF-8 字节签名。向 `POST /agent/v1/session` 提交 `{deviceId,challenge,signature}`，签名为 64 字节 P1363 的 Base64URL。返回 `{token,expiresAt}`。后续 Agent 路由使用此 Bearer。
3. `GET /agent/v1/ws` 升级后交换 UTF-8 JSON 帧。服务端按 `command.id` 调用文件、监控、权限、诊断能力。WS 端通过 `ping/pong` 测 RTT，重复命令由 Agent 按 ID 去重。队列限制、超时与设备离线用标准错误映射。
4. WSS 暂时不可用时，Agent 用 `GET /agent/v1/commands` 长轮询约 20 秒，通过 `POST /agent/v1/frames` 批量回送 `{frames:[...]}`。通过 `GET /agent/v1/policy` 同步策略，HTTPS 模式以 `POST /agent/v1/pulse` 上报 RTT。Agent 感知接口、可达性和代理指纹变化，在轮询窗口到期后重试 WSS。故障重试采用带抖动的指数退避。
5. 指标用 `event` 帧推送，快照及分页历史落 SQLite。CPU 与内存默认手动刷新，高频采样可单独设为 5–3600 秒。应用生命周期和磁盘连接走系统通知，已安装应用用扫描对账。网络变化与电源信息按事件和低频采样同步。

```json
{"type":"command","id":"0e2706c0-30f8-44dd-8a7a-8f6fce9c5585","kind":"files.stat","payload":{"root":"8a98c55a-bb1c-49ef-8c59-4af48f0cde53","path":"plan.pdf","summary":false}}
```

Agent 返回 `{type:"result",id,ok:true,payload}` 或 `{type:"result",id,ok:false,code}`。遥测帧为 `{type:"event",id,topic,snapshot,payload}`。WSS 的收到确认使用 `{type:"ack",id}`。带网络中断的结果可能未知，修改请求返回设备超时时，前端应重新读取目标状态和版本。

## 目录监听与数据中继

- 前端先订阅 `files.changed`，收到确认后向 REST 拉取目录快照。服务端引用计数复用同一设备、根、相对路径的监听，定期续费 Agent 侧租约。Agent 每台最多四个观察目录。
- FSEvents 通知触发有界目录对账。采用本地设备号及 inode 匹配同批次的单一重命名，输出 `fromPath` 和新元数据。系统标记丢失事件或变化批过大时请求重读快照。监听器无订阅后释放。
- 单文件通过 256 KiB 源文件块中继，可按强 ETag 和字节 Range 断点续传。服务端通过背压限制并发，逐块验证文件版本；写入目标通过暂存和提交保护已存在文件。
- ZIP 作业遍历同一个已授权根中的选中项目，将逐块抵达服务端的文件写入服务端 `.part` 归档。归档完成后同盘改名发布，管理 API 提供需要当前会话的下载 URL。支持多选、隐藏项、空目录和 ZIP64。作业及并发有配额。
- FTP 的虚拟根列出该账号拥有可用目录授权的在线设备 UUID。进入设备后列出根授权 ID。FTP 数据连接由服务端被动监听，`LIST`、`MLSD`、`MLST`、`SIZE`、`MDTM` 与 `RETR` 映射到相同文件能力。 `REST STREAM` 按源版本校验已知续传记录。第三方客户端可递归下载文件夹。管理 API 提供文件写操作。

## macOS 约束

Agent 在 Aqua 用户会话内运行，锁屏期间仍在该会话。FileVault 预启动状态与用户注销期间由 macOS 管理。文件夹权限请求通过本机原生文件访问触发可能的系统提示，结果包括最近观测时间和设置页。Input Monitoring 与 Pasteboard 提供状态和本机设置引导。诊断目录限定 `osVersion`、`uptime`、`diskSpace` 和 `agentHealth`。

电源辅助服务依据经认证的 Agent 策略租约、AC 电源、至少 40% 电池、低电量模式和热状态执行。它仅管理自己取得的 `SleepDisabled` 设置，租约失效时恢复，并在重启时检查恢复标记。用户态 IOKit 断言处理防空闲睡眠。显示器、屏保及锁屏密码由 macOS 或 MDM 控制。硬件合盖行为仍须在目标 Mac 验收。设计参考 [Capsomnia 的电源实现说明](https://github.com/fuji-mak/Capsomnia#security) 与 [Apple 的 IOKit 断言说明](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)。

## 持久化与运行限制

SQLite 使用 WAL。事件保留 30 天并限制约 25 万条，目录变更事件保留 15 分钟，审计保留 90 天，ZIP 产物保留 24 小时。传输超过 64 GiB 或归档超过 10 万条目会拒绝。单目录扫描上限 5 万子项，分页每次最多 200 条。文件与任务状态的历史均以服务端时钟为准。SQLite 配置和内存中的连接中枢适用于单实例部署。
