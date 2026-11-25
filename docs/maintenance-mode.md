# Agent 维护模式

每台 Mac 可开启一个最多十分钟的维护窗口。开启后，已经在运行的 Agent 继续服务。它退出后，launchd 拉起的进程只等待租约结束。窗口到期后，launchd 从安装路径重新启动常规 Agent，可以加载维护期间换入的版本。此功能需要支持维护模式的服务器和 macOS Agent 0.5.12 或以上版本。 [Apple LaunchAgent 文档](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## 更新操作

1. 先将新版 App 或安装包准备到目标 Mac。确认设备已在线，管理员已授权当前连接。读取维护状态检查 `supported` 为 `true`。
2. 将当前 `connectionId` 提交到开启接口。等接口返回 201 且状态为 `active`，再停止 Agent。响应中的 `expiresAt` 是本次窗口的固定截止时间。
3. 停止当前进程并将新 App 放回原安装路径。可在对应的 macOS 登录用户会话中使用下面的命令。拖装后可以打开新 App 刷新现有后台项目注册。
4. 调用结束接口，或者等待十分钟窗口结束。Mac 在线且服务器可达时，提前结束通常在数秒内生效。重新上线后，使用新的 `connectionId` 进行远程操作授权。还需要维护时，可以为在线 Agent 开启新窗口。

```sh
launchctl kill SIGTERM "gui/$(id -u)/in.ryanl.filesharing.agent"
```

维护期使用已注册的后台项目保留恢复链路。「停用后台服务」和 `launchctl bootout` 会移除这条链路。更新应在窗口内完成并让一个可执行的版本留在原安装路径。机器关闭、注销或睡眠时，启动遵循系统和用户会话的实际可用状态。

## 管理接口

使用已解锁的 Passkey 管理会话。POST 和 DELETE 携带同源 `Origin`。以下路径均位于 `/api/v1/devices/{id}` 下。

| 方法与路径 | 参数 | 响应 |
| --- | --- | --- |
| `GET /maintenance` | 无 | `200`，当前或最近一次维护状态。 |
| `POST /maintenance` | `{"connectionId":"当前连接 UUID"}` | `201`，Agent 已在本地保存租约的状态，`Location` 指向读取接口。 |
| `DELETE /maintenance/{leaseId}` | 保持目标租约 UUID | `204`，服务器放行该租约，支持 Agent 已停机时调用。重复结束同一租约返回 204。 |

状态响应包含 `deviceId,supported,state,leaseId,startedAt,expiresAt,confirmedAt,endedAt,remainingSeconds`。时间是 ISO 8601 UTC。日期和租约 ID 在未开启过时为 `null`。`supported` 表示当前在线连接声明支持维护模式。`state` 为 `inactive,preparing,active,ended,expired`。服务端从创建租约起计时，截止时间为 `startedAt` 加 600 秒。一个有效窗口内再次开启会返回 409，原截止时间保持固定。开启未收到本地确认时，服务端释放待确认租约。若服务端在确认过程中停机，待确认状态最多有效 18 秒，Mac 仍以已记录的本地截止时间兜底。

| 状态码 | 代码及处理 |
| --- | --- |
| 403 | `agent_connection_access_required`，先授权目标的当前连接。 |
| 404 | `maintenance_lease_not_found`，刷新状态后使用本次租约 UUID。 |
| 409 | `maintenance_already_open` 表示已有窗口，`agent_connection_changed` 表示连接已切换，`maintenance_lease_ended` 表示等待确认期间窗口已结束。 |
| 422 | `maintenance_agent_upgrade_required`，先更新并启动支持此功能的 Agent。 |
| 503 | 设备离线、超时或本地租约无法确认。读取状态后再决定是否继续更新。 |

`/api/v1/events/ws` 可按设备订阅 `maintenance.changed`。确认开启与提前结束时发送 `{leaseId,state,startedAt,expiresAt,endedAt}` 并留下审计记录。客户端根据 `expiresAt` 显示到期，重连时可以拉取当前状态或用普通事件游标回放。 [HTTP 请求示例](../FileSharing.http) · [AsyncAPI](asyncapi.yaml)

## 恢复机制

租约通过当前获授权的 WSS 或 HTTPS Agent 连接下发。Agent 保存本机启动标识、单调时钟截止时间和仅用于查询这一份租约的短期凭据，再向服务端确认。服务器只存凭据哈希。等待进程通过同一个服务源查询租约是否已经结束。

Mac 从发起确认查询前开始计算本地截止时间。期间的网络延迟、再次杀掉等待进程、系统时钟调整或服务器重启都无法延长本地窗口。服务器不可达时仍在本地截止时间放行。若 Mac 已重启，旧启动会话中的本地租约失效，launchd 按正常规则启动 Agent。服务端状态可通过结束接口立即清理。 [Apple 连续时钟文档](https://developer.apple.com/documentation/driverkit/mach_continuous_time)
