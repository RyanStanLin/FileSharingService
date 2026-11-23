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
- SQLite 在同一事务写入投递和状态摘要，服务重启恢复队列。渠道编辑、停用或删除时取消尚未发出的旧修订投递。已进入上游调用的请求可能完成。
- 最多保存 64 个渠道、全局 2,000 笔待投递、单渠道 500 笔。投递和更新保留最多 30 天，同时分别受最近 50,000 与 100,000 个序号限制。测试幂等键随投递保留。
- 在 `GET /api/v1/events/ws` 收到 `ready` 后发送 `{"type":"subscribe","id":"notify","topic":"notifications.changed"}`。用 `subscribed.cursor` 保存通知游标，收到事件后推进到 `item.sequence`。用 `after` 重订阅，或 `GET /updates?after={cursor}&limit=100` 回放。通知游标独立于其他设备事件的游标。缺省 `after` 的 WS 从当前尾部开始，REST 从最早保留记录开始。过期游标返回 `notification_resync_required`，此时重读配置与投递后重新订阅。`item.payload` 含 `resource,id,action,revision,state,channelId,ruleId`。 [AsyncAPI](asyncapi.yaml)
