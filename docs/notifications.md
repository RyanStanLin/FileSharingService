# Milestone 3 通知 API

Base URL 为 `/api/v1/notifications`。所有请求使用已解锁的 Passkey 管理会话。写入、Bot 验证和 WebSocket 握手都要发送同源 `Origin`。错误使用现有 Problem Details 格式，具体原因在 `code`。

## 渠道设置

| 方法与路径 | 行为 |
| --- | --- |
| `GET /channels?cursor=&limit=` | 以渠道 UUID 分页，返回 `items,nextCursor`。 |
| `POST /channels` | 新建渠道。返回 201 与 `Location`。 |
| `GET /channels/{id}` | 读取公开设置、`credentialConfigured`、修订号与时间。 |
| `PUT /channels/{id}` | 用当前 `revision` 完整替换公开设置。省略凭据会沿用已存凭据。 |
| `DELETE /channels/{id}?revision=N` | 删除渠道，返回 204，保留历史投递。 |
| `POST /channels/{id}/verify` | 调用 Telegram `getMe` 与 `getChat`，返回 `botId,botUsername,chatId,chatType`。 |
| `POST /channels/{id}/test` | 通过启用的渠道排队发送测试消息。返回 202 与指向投递记录的 `Location`。 |

渠道共有 `name,kind,enabled`。每个收件目标用一个独立渠道。渠道类型在创建后固定，可停用渠道、改收件设置或轮换凭据。下列两种 JSON 可直接作为创建请求的结构。

```json
{
  "name": "运维 iPhone",
  "kind": "bark",
  "enabled": true,
  "bark": {
    "server": "https://api.day.app",
    "deviceKey": "REPLACE_WITH_DEVICE_KEY",
    "group": "FileSharing",
    "sound": "bell",
    "level": "active"
  }
}
```

```json
{
  "name": "Telegram 运维群",
  "kind": "telegram",
  "enabled": true,
  "telegram": {
    "botToken": "REPLACE_WITH_BOTFATHER_TOKEN",
    "chatId": "-1001234567890",
    "messageThreadId": 71,
    "silent": true
  }
}
```

- Bark 从 App 获取设备 Key。默认访问 `https://api.day.app`。部署端可在 `FILESHARING_BARK_ORIGINS` 增加逗号分隔的 HTTPS origin。更换 origin 时需要提交有效设备 Key。可选的 `level` 为 `active,timeSensitive,passive,critical`。发送使用 BarkerSharper 文档同样的 `POST /push` JSON 协议。服务管理连接超时及重试，并以 Bark 的成功回执为准。 [BarkerSharper](https://github.com/RyanStanLin/BarkerSharper) · [Bark API](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md)
- Telegram 从 BotFather 取得 Bot Token。私聊先给 bot 发送 `/start`。群组将 bot 加入并允许发言，频道授予发布权限。用带符号的十进制 Chat ID 字符串，受 Telegram 支持的公开目标也可用 `@username`。论坛 topic 可加正整数 `messageThreadId`。先调用 `verify` 确认目标，再调用 `test` 验证发言权限。 [BotFather 指南](https://core.telegram.org/bots/tutorial) · [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)
- 测试需要 `Idempotency-Key`，同一渠道与消息重放返回原投递。请求正文为 `{"title":"测试通知","body":"FileSharing 已接通"}`，也可提交 `{}` 使用默认文案。
- 创建需要服务端启用独立的 32 字节密钥。Bark Key 与 Bot Token 写入时加密，读取、审计及 WebSocket 只含公开字段。保存渠道和编辑规则均不触发测试消息。部署设置见 [生产部署](deployment.md)。

## 投递与重放

- `GET /deliveries?after=&limit=&channelId=&ruleId=&deviceId=&state=` 使用序号字符串向前翻页，每页最多 200 条，返回 `items,cursor,hasMore`。
- `GET /deliveries/{id}` 查看触发时间、投递状态、消息正文、尝试次数、上游 HTTP 状态、重试时间和 Telegram message ID。
- 状态为 `queued,sending,retryScheduled,sent,failed,cancelled`。成功表示上游接受发送请求。网络故障、HTTP 408、429 和 5xx 最多尝试 5 次，初始退避为 5 秒，逐次增至 20、80、320 秒，必要时遵循服务商的 `Retry-After` 或 `retry_after`。运输失败若发生在上游接受后，补发可能产生重复消息。
- SQLite 在同一事务写入投递和状态摘要，服务重启恢复队列。渠道或规则修改后取消尚未发出的旧修订投递。设备或根授权撤销会取消对应待投递及补发。已进入上游调用的请求可能完成。
- 最多保存 64 个渠道、全局 2,000 笔待投递、单渠道 500 笔。投递和更新保留最多 30 天，同时分别受最近 50,000 与 100,000 个序号限制。测试幂等键随投递保留。
- 在 `GET /api/v1/events/ws` 收到 `ready` 后发送 `{"type":"subscribe","id":"notify","topic":"notifications.changed"}`。用 `subscribed.cursor` 保存通知游标，收到事件后推进到 `item.sequence`。用 `after` 重订阅，或 `GET /updates?after={cursor}&limit=100` 回放。通知游标独立于其他设备事件的游标。缺省 `after` 的 WS 从当前尾部开始，REST 从最早保留记录开始。过期游标返回 `notification_resync_required`，此时重读配置与投递后重新订阅。`item.payload` 含 `resource,id,action,revision,state,channelId,ruleId`。 [AsyncAPI](asyncapi.yaml)

## 事件规则与模板

| 方法与路径 | 行为 |
| --- | --- |
| `GET /event-types` | 返回所有事件类型、变量说明、可用过滤条件、配置上限及凭据功能是否启用。 |
| `GET /rules?cursor=&limit=&deviceId=&enabled=` | 按设备或启用状态筛选，使用 UUID 游标分页。 |
| `POST /rules` | 创建规则，返回 201 与 `Location`。 |
| `GET /rules/{id}` | 读取匹配条件和累计计数。 |
| `PUT /rules/{id}` | 用当前 `revision` 完整替换规则。 |
| `DELETE /rules/{id}?revision=N` | 删除规则并取消旧规则的待投递记录。 |
| `POST /rules/preview` | 用样本上下文渲染模板，返回 `message,missingVariables`。 |

```json
{
  "name": "编辑器活动",
  "deviceId": "1a4e2b2d-fc00-4187-b47a-dfe35c4e7b52",
  "enabled": true,
  "events": ["application.launched", "application.terminated"],
  "channelIds": ["55032126-ea7a-49a1-a849-54f8553c40ab"],
  "filter": {"bundleId": "com.example.editor"},
  "cooldownSeconds": 30,
  "template": {
    "title": "{{device.name}}",
    "body": "{{app.name}} · {{event.type}} · {{event.occurredAt}}"
  }
}
```

规则选择一台已登记的 Mac、1–16 个事件类型及 1–8 个渠道。全局可保存 128 条，每台最多 32 条。一个事件可命中多条规则。`bundleId` 不区分大小写，`applicationId` 和 `storageId` 精确匹配，只用于对应类别。阈值规则必须设置 `thresholdPercent` 为 1–100 整数。初次采样建立基线，从低于阈值到达到或超过阈值、从达到或超过阈值到低于阈值时触发相应事件。

`cooldownSeconds` 默认为 0，可设为 0–86400 秒。同一规则与事件类型从上次成功排队起计算冷却。每次匹配增加 `matchedEvents`，每个入队目标增加 `enqueuedDeliveries`。冷却、停用渠道或队列达到上限导致跳过的目标计入 `skippedDeliveries`。修改配置后规则使用新修订并重新开始计算冷却，累计计数保留。渠道被规则引用时先更新或删除规则，再删除渠道。

模板使用 `{{变量名}}`，花括号内允许空格。变量名称由当前规则的事件类型决定，缺失值插入空字符串，值中的花括号按原文发送。正文展开后若为空，以事件标识填充。标题缺省为 `FileSharing`。渲染后标题和正文分别限制在 180 和 2,800 UTF-8 字节，超出会加省略号且保留完整 Unicode 字符。Telegram 以纯文本发送标题和正文，并关闭链接预览。可用以下请求预览，API 自行生成事件类型和当前 UTC 时间。

```json
{
  "event": "application.launched",
  "template": {"title": "{{device.name}}", "body": "{{app.name}} {{app.version}}"},
  "context": {"device.name": "Desk Mac", "app.name": "Editor"}
}
```

| 事件族 | 触发来源 |
| --- | --- |
| `device.online/offline` | 服务端观测到获信连接断开及恢复，包括心跳到期。首次绑定建立基线。 |
| `lid.closed/opened` | Agent 观测到盖状态改变。 |
| `system.sleeping/woke/locked/unlocked`、`display.slept/woke` | macOS 休眠、唤醒、会话和屏幕事件。Agent 被系统暂停时，网络来不及送达的事件可在唤醒后补报。 |
| `application.*` | 启动、退出、激活、停用、隐藏、取消隐藏、安装、移除及升级。 |
| `storage.*` | 外接存储插入、移除、挂载和卸载。 |
| `battery.*`、`power.*` | 充电、外接电源和低电模式切换，以及电量跨阈值。 |
| `network.*`、`display.configurationChanged` | 可达性、主网卡、VPN 和显示配置的样本变化。 |
| `cpu.usageAbove/Below`、`memory.usageAbove/Below` | 收到性能样本并跨阈值。需要启用该采样间隔或按需刷新。 |
| `clipboard.changed`、`telemetry.gap` | 剪贴板变化只提供时间。遥测积压丢失可单独订阅。 |

更新到支持通知的 Agent 后，给它的当前连接授权一次。服务器只保存 Agent 安装凭据的哈希。此后识别同一安装的在线恢复与系统事件，文件与远程控制仍走各自连接授权。旧 Agent 的系统事件需要它的当前连接已授权。重新安装导致凭据变化时，核对并授权新连接即可重新绑定。服务离线期间无实时观测，服务重启后只基于已记录的离线状态判断恢复。系统离散事件超过 10 分钟才送达时只保留在普通设备历史中，采样及连接事件使用服务端接收时间。

## 目录通知

使用已授予的根目录 ID 和相对路径。空字符串监听根目录本身。详情事件针对所选目录的直接子项，子目录可用自己的规则独立监听。多条规则选同一个设备、根和目录时共用一个监听。每台设备最多配置 8 个启用的通知目录，Agent 为通知和现有文件浏览各自保留监听容量。

```json
{
  "name": "报告变动",
  "deviceId": "1a4e2b2d-fc00-4187-b47a-dfe35c4e7b52",
  "enabled": true,
  "events": ["file.added", "file.removed", "file.renamed", "file.modified"],
  "channelIds": ["55032126-ea7a-49a1-a849-54f8553c40ab"],
  "filter": {
    "file": {
      "rootId": "eb3e6cd2-f602-4194-a60b-8c1af3f7644c",
      "path": "Documents/Reports",
      "entryKind": "file",
      "nameGlob": "*.pdf"
    }
  },
  "template": {
    "title": "{{device.name}} · 报告",
    "body": "{{event.type}} · {{file.name}} · {{file.path}}"
  }
}
```

- `file.added` 和 `file.removed` 表示子项出现或消失。将文件移出目录也会产生 `file.removed`。
- `file.renamed` 从同一批次的 inode 对账取得原名和新名，可插入 `{{file.oldName}}` 与 `{{file.name}}`。跨目录移动通常在两端各表现为一条移除与新增。
- `file.modified` 依据文件或条目版本变化，覆盖内容、大小、时间和模式变化。
- `file.directoryChanged` 每批提供一次目录级通知。正常对账包含 `directory.changeKind=delta` 和 `directory.changeCount`。系统合并事件或目录条目太多时会报 `coalesced`，目录无法再次读取时报 `unavailable`。初次建立基线不会通知。
- `entryKind` 可选 `file,directory,symlink,other`。可选的 `nameGlob` 区分大小写，支持 `*` 和 `?`，对重命名匹配任一端名称。两者只筛选子项详情事件。目录级事件统计整个目录的观察批次。
- 变量包含根 ID、相对目录和文件路径、文件名、旧路径/名称、类型、扩展名、大小和修改时间。Agent 使用现有本机目录限制，事件只携带相对路径与适量元数据。FSEvents 批次与目录快照可能合并短时间内的多次操作。

`GET /watches?deviceId={id}` 返回启用规则且至少有一个启用目标的目录，每项含 `deviceId,rootId,path,ruleIds,state,checkedAt,error`。状态为 `checking,starting,active,waitingForConnection,awaitingAuthorization,unavailable`。连接恢复后，重新授权当前连接以恢复目录监听。监听由服务器后台续约，管理员锁定会话、关闭浏览器、停止订阅均不会终止监听。规则停用、最后一个启用渠道停用、目录授权撤销或 Agent 断开时停止对应监听。目录不可访问的原因在 `error`，如 `root_access_denied` 或 `notification_watch_requires_agent_upgrade`。使用 Agent 0.5.0 及以上版本接收文件通知。

关联投递的 `context` 为可渲染变量的字符串字典。 `sourceSequence` 指向同一批来源并可用于关联；对目录批次，多个投递可共享同一个来源序号。浏览器现有 `files.changed` 订阅仍使用自己的目录租约。全局 `notifications.changed` 提供通知配置和投递状态变动，需要完整状态或消息正文时按 ID 查询 REST。
