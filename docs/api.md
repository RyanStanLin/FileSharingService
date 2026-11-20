# FileSharing 前端 API v1

管理 API 使用 HTTPS 同源访问，路径前缀为 `/api/v1`。下文用 `D` 表示设备 UUID，`R` 表示服务器根授权 UUID。JSON 属性采用 camelCase。数字序列游标用十进制字符串，避免前端精度损失。日期除特别说明外为 ISO 8601。可用的 OpenAPI 文档由服务端在 `/openapi/v1.json` 生成，生产环境访问需要已解锁会话。可执行请求示例见 [FileSharing.http](../FileSharing.http)。

## Passkey 与锁定状态

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /auth/status` | 无 | `200 {initialized,unlocked,session}` |
| `POST /auth/passkeys/registration/options` | `{secret}` | `200 {challengeId,publicKey}` |
| `POST /auth/passkeys/registration` | `{secret,challengeId,credential}` | `204` |
| `POST /auth/passkeys/authentication/options` | 空 | `200 {challengeId,publicKey}` |
| `POST /auth/passkeys/authentication` | `{challengeId,credential}` | `200 {id,createdAt,expiresAt}` 与 Set-Cookie |
| `POST /auth/passkeys/recovery/options` | `{secret}` | `200 {challengeId,publicKey}` |
| `POST /auth/passkeys/recovery` | `{secret,challengeId,credential}` | `204` 并撤销全部管理会话 |
| `POST /auth/lock` | 空 | `204` 并清除当前会话 |

首次访问时先读取状态。`initialized:false` 时由管理员提供部署 `.env` 中的随机密钥。密钥只在注册或恢复流程的两个 POST 请求体中发送。前端可以通过以下逻辑提交浏览器原生凭证。注册及恢复完成后执行验证流程解锁。浏览器须支持 WebAuthn 和 JSON 转换接口。

```javascript
async function apiPost(path, body) {
    const response = await fetch("/api/v1" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) throw await response.json()
    return response.status === 204 ? undefined : response.json()
}

async function setupPasskey(secret, recovery = false) {
    const path = "/auth/passkeys/" + (recovery ? "recovery" : "registration")
    const { challengeId, publicKey } = await apiPost(path + "/options", { secret })
    const credential = await navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey)
    })
    return apiPost(path, { secret, challengeId, credential: credential.toJSON() })
}

async function unlock() {
    const path = "/auth/passkeys/authentication"
    const { challengeId, publicKey } = await apiPost(path + "/options")
    const credential = await navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey)
    })
    return apiPost(path, { challengeId, credential: credential.toJSON() })
}
```

每个 challenge 只有一次提交机会，2 分钟内有效。生产 Cookie 为 `__Host-fs-admin`，浏览器自动保存并发送。修改请求和 WebSocket 握手须携带精确同源的 `Origin`。HTTP 客户端测试时显式添加此头。上锁后所有管理调用返回 `401`，FTP 账号继续按各自授权工作。

```json
{"initialized":true,"unlocked":false,"session":null}
```

## 通用响应

列表 `limit` 默认为 50，范围 1–200。按游标分页的列表使用上一页的 `nextCursor`，最后一页为 `null`。事件历史使用 `after` 和以下示例中的 `cursor`。目录分页使用单独的偏移量及快照修订号。

```json
{"items":[{"id":"144bae60-503d-45e3-8a17-ec7a64886c20","name":"Design Mac"}],"nextCursor":null}
```

```json
{"items":[{"sequence":"1203","deviceId":"144bae60-503d-45e3-8a17-ec7a64886c20","topic":"cpu","time":"2026-11-19T08:22:00Z","payload":{"usagePercent":12.1}}],"cursor":"1203","hasMore":false}
```

错误使用 `application/problem+json`，由 `status` 与 `code` 分流。框架级方法拒绝、模型绑定和请求大小限制也可能只提供标准 Problem Details 的 `title`。

```json
{"title":"snapshot_changed","status":409,"code":"snapshot_changed","traceId":"0HN6B4M91Q846:0000002A"}
```

| HTTP | 常见错误码 |
| --- | --- |
| 400 | `invalid_request`、`invalid_path`、`invalid_sort`、`invalid_directory_page`、`invalid_cursor`、`invalid_time_range`、`unsupported_permission`、`invalid_diagnostic_command` |
| 401 | `authentication_required`，含会话锁定、WebAuthn 失败、challenge 已消费或密钥错误 |
| 403 | `invalid_origin`、`invalid_host`、`root_access_denied`、`agent_connection_access_required`、`permission_denied`、`filesystem_access_denied` |
| 404 | `not_found`、`device_not_found`、`ftp_account_not_found`、`snapshot_unavailable`、`transfer_not_found` |
| 409 | `revision_conflict`、`device_already_connected`、`agent_connection_changed`、`device_capacity`、`passkey_already_configured`、`passkey_configuration_changed`、`snapshot_changed`、`already_exists`、`directory_not_empty`、`cross_volume`、`delete_incomplete`、`root_identity_changed` |
| 410 | `resync_required`、`archive_expired`、`agent_connection_ended` |
| 412 | `version_mismatch`，重新获取条目版本 |
| 413 | `too_large`、`invalid_chunk_length`、`archive_size_limit`、`archive_entry_limit` |
| 416 | `range_not_satisfiable`，响应含 `Content-Range: bytes */<length>` |
| 422 | `unsupported` |
| 428 | `file_version_required` |
| 429 | `device_busy`、`limit_reached`、`archive_limit`、`stream_limit`、`watch_limit`、`job_limit` 或请求频率限制 |
| 503 | `device_unavailable`、`device_timeout` 或设备操作失败 |

## 公网自动接入、设备与策略

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `GET /devices` | `cursor,limit,search,includeRevoked` | `200 Page<Device>` |
| `GET /devices/D` | 无 | `200 Device` |
| `PUT /devices/D` | `{name,profileId,revision}` | `200 Device` |
| `DELETE /devices/D` | 无 | `204` 注销 UUID 并释放名额 |
| `PUT /devices/D/connection-access` | `{connectionId,enabled}` | `200 Device.connection`，控制当前连接的远程操作 |
| `GET /devices/D/policy` | 无 | `200 {deviceId,revision,inherited,settings}` |
| `PUT /devices/D/policy` | `{revision,settings}`，`settings:null` 恢复继承 | `200 DevicePolicy` |
| `GET /collection-profiles` | `cursor,limit` | `200 Page<Profile>` |
| `POST /collection-profiles` | `{name,settings}` | `201 Profile` |
| `GET /collection-profiles/{id}` | UUID 或 `default` | `200 Profile` |
| `PUT /collection-profiles/{id}` | `{name,settings,revision}` | `200 Profile` |
| `DELETE /collection-profiles/{id}` | 无 | `204` 移除未被设备使用的自定义配置 |

```json
{"id":"144bae60-503d-45e3-8a17-ec7a64886c20","name":"Design Mac","profileId":"default","createdAt":"2026-11-19T08:21:00Z","revokedAt":null,"revision":1,"connection":{"online":true,"protocol":"wss","connectedAt":"2026-11-19T08:21:05Z","lastCommunicationAt":"2026-11-19T08:22:00Z","latencyMs":8.2,"connectionSeconds":55,"connectionId":"2191fa7c-cebe-40ad-baea-56b42a4276dc","accessGranted":false,"peerAddress":"203.0.113.15"}}
```

设备可以在公网自动登记和上线。管理端可以用 `connectionId` 识别当前连接，用 `accessGranted` 控制文件浏览及远程操作按钮。管理员确认当前连接后提交 `{connectionId,enabled:true}`，提交 `enabled:false` 则结束当前连接的远程操作授权。重连使用同一设备 UUID，并自动产生新的 `connectionId`。过期的连接 ID 返回 `agent_connection_changed`。Agent 握手及 HTTPS 长轮询见 [架构协议](architecture.md#通信协议)。

Profile 为 `{id,name,settings,revision}`。采样周期以秒为单位，`0` 表示由手动刷新或系统事件触发。KeepAwake 是配置状态，生效状态位于设备的 `power` 样本。

```json
{"cpu":0,"memory":0,"disk":60,"battery":60,"displays":0,"network":30,"system":60,"agent":60,"power":60,"storage":60,"appsRunning":60,"keepAwake":true}
```

## 根与权限

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `GET /devices/D/file-roots/local` | 无 | `200 [{rootKey,label,writable,primary}]` Mac 声明 |
| `GET /devices/D/file-roots` | `cursor,limit` | `200 Page<Root>` 当前服务器授权 |
| `POST /devices/D/file-roots` | `{rootKey,label,writable,enabled}` | `201 Root` |
| `GET /devices/D/file-roots/R` | 无 | `200 Root` |
| `PUT /devices/D/file-roots/R` | `{rootKey,label,writable,enabled,revision}` | `200 Root` |
| `DELETE /devices/D/file-roots/R` | 无 | `204`，相关 FTP 授权一并失效 |
| `GET /devices/D/permissions` | 无 | `200 Snapshot`，`value` 以五个权限名为键 |
| `POST /devices/D/permissions/requests` | `{kind}` | `202 Job`，用同一端点重试 |

Root 为 `{id,deviceId,rootKey,label,writable,enabled,revision}`。TCC 管理包含 `downloads`、`documents`、`desktop`、`inputMonitoring`、`pasteboard`。目录读写以服务器 Root、终端本地范围和 macOS 权限的交集为准。系统结果包括 `notDetermined`、`allowed`、`denied`、`requiresSystemSettings`、`unavailable` 或 `unknown`。phase 为 `idle`、`requesting`、`completed`。在权限作业完成前向用户展示 macOS 设备本机操作提示。

`filesystem_access_denied` 表示 macOS 拒绝相应文件操作。`root_identity_changed` 表示本地共享根的卷 UUID 或目录 inode 校验失败，需要在 Mac 上确认路径并重新批准该根。Agent 会自动升级路径和 inode 仍匹配、仍归当前用户所有的旧 HOME 记录，保留原根标识及服务器授权。其他旧记录在装载编号一致时自动取得卷 UUID。已经换号、无法确认卷身份的旧外置共享根需要在 Mac 上重新选定。

剪贴板请求返回系统报告的应用级设置。`requiresSystemSettings` 对应「每次询问」，单次系统许可后也可能保持这个状态。`allowed` 对应「始终允许」，`denied` 对应「始终拒绝」，`notDetermined` 表示系统尚未建立应用权限条目。剪贴板权限探测回报中只有权限状态和时间。 [Apple 剪贴板权限说明](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-swift.enum)

```json
{"topic":"permissions","observedAt":"2026-11-19T08:22:00Z","stale":false,"value":{"documents":{"state":"allowed","phase":"completed","checkedAt":"2026-11-19T08:22:00Z","systemSettingsPane":"Privacy_FilesAndFolders"}}}
```

## 文件与目录

文件参数 `path` 使用原始名称以 `/` 连接，作为查询参数时做 URL 编码。共享根用空路径。`rootId` 必须使用服务器根授权 ID。名字内带有空格、扩展名和 Unicode 均可按原样提交。

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `GET /devices/D/files/entries` | `rootId,path?,hidden?,sort?,direction?,offset?,limit?,revision?` | `200 DirectoryPage` |
| `GET /devices/D/files/entry` | `rootId,path?,summary?`，目录默认返回聚合 | `200 FileEntry` |
| `GET /devices/D/files/thumbnail` | `rootId,path,version`，可为空路径 | `200 image/png` |
| `POST /devices/D/files/directories` | `{rootId,path}` | `201 FileEntry` |
| `POST /devices/D/files/renames` | `{rootId,path,newName,version}` | `200 FileEntry` |
| `POST /devices/D/files/moves` | `{rootId,path,destination,version,destinationRootId?}`，跨授权根要求同设备同卷 | `200 FileEntry` |
| `POST /devices/D/files/trash` | `{rootId,path,version}` | `200 {path,trashName}` |
| `DELETE /devices/D/files/entry` | `rootId,path,version,recursive?` | `204` 永久删除 |

`hidden=true` 显示允许访问的隐藏项。排序键为 `name`、`size`、`createdAt`、`modifiedAt`、`type`、`lastOpenedAt`。默认名称升序，方向用 `asc` 或 `desc`。目录的列表 size 值为 0，递归大小见 `folder.folderSize`。目录页依次传入 `nextOffset` 和上一页的 `revision`，保持过滤与排序条件。收到 `snapshot_changed` 后从第 1 页重取。前端用 `snapshotRevision` 对照 WS 的 `previousRevision`，两个 revision 的用途不同。

```json
{"revision":"page-revision","snapshotRevision":"directory-snapshot","total":1,"items":[{"name":"plan.pdf","path":"project/plan.pdf","fullPath":"/Users/managed/project/plan.pdf","kind":"file","size":2048,"createdAt":"2026-11-19T08:21:00Z","modifiedAt":"2026-11-19T08:22:00Z","lastOpenedAt":null,"lastAccessedAt":"2026-11-19T08:22:00Z","fileType":"com.adobe.pdf","extension":"pdf","owner":501,"mode":420,"version":"entry-version","hidden":false,"thumbnail":"pdf","folder":null}],"nextOffset":null}
```

`mode` 是 POSIX 数字权限，上例 420 即 `0644`。lastOpenedAt 使用 Spotlight 的 LastUsedDate，未索引时为 `null`。缩略图值为 `image`、`pdf`、`file`、`folder` 或 `null`。前端按需加载 PNG。图片和 PDF 以有界尺寸取预览，其余取类型图标。目录的聚合形如 `{folderSize:7248,filesCount:5,foldersCount:2,complete:true}`。聚合跳过受保护目录，达到扫描限制或遇到权限不足时可返回 `complete:false`。废纸篓适用于与用户 HOME 同卷且 Finder 废纸篓可访问的项目。永久删除非空目录需要 `recursive=true`，并检查条目版本和范围。

## 文件传输与 ZIP

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `POST /transfers` | `Idempotency-Key`，`{deviceId,rootId,kind,path?,version?,length?,entries?}` | `201 Transfer`，同请求重试 `200` |
| `GET /transfers` | `cursor,limit,deviceId,state` | `200 Page<Transfer>` |
| `GET /transfers/{id}` | 无 | `200 Transfer` |
| `DELETE /transfers/{id}` | 无 | `204`，取消待传输的作业 |
| `GET /transfers/{id}/content` | 可选 `Range,If-Range` | `200` 或 `206` 文件或 ZIP |
| `HEAD /transfers/{id}/content` | 可选 `Range,If-Range` | 同 GET 的元数据头 |
| `PUT /transfers/{id}/content` | `Upload-Offset`，单块 binary，1 至 262144 字节 | `204`，响应头 `Upload-Offset` |
| `POST /transfers/{id}/commit` | 空 | `200 FileEntry` |

`kind` 取 `download`、`archive` 或 `upload`。单文件下载提供 `path`，待客户端重试时保留原先 ETag 并请求 `Range: bytes=<next>-`。源文件替换时返回 `412`。归档在同设备同根选择 `entries` 中的文件或文件夹，最多 100 项。可用 `path` 指定一个目录，空路径表示整个已授权根。ZIP 作业由 `preparing` 变为 `ready` 后返回 `downloadUrl`。准备期间 `offset` 表示已整理的源字节数，成品发布时重置。下载上传进度是已登记的连续偏移。上传指定 `length`，覆盖现有文件时携带目的文件版本，传满后 commit。每个文件/归档上限 64 GiB。下载链接受会话与根授权控制。

```json
{"id":"2204ec63-266b-45d3-8f67-8a088c744b21","deviceId":"144bae60-503d-45e3-8a17-ec7a64886c20","rootId":"84a38c77-f769-4e27-b6d0-331281675ebd","kind":"archive","state":"ready","path":"","fileName":"files.zip","version":"2204ec63-266b-45d3-8f67-8a088c744b21","length":34181,"offset":0,"createdAt":"2026-11-19T08:22:00Z","updatedAt":"2026-11-19T08:22:02Z","error":null,"downloadUrl":"/api/v1/transfers/2204ec63-266b-45d3-8f67-8a088c744b21/content"}
```

## FTP、FTPS 和 SFTP

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `GET /ftp/connection` | 无 | `200 [{mode,host,port,scheme,address,hostKeyFingerprint?,available?}]` |
| `GET /ftp/connections` | 可选 `accountId` | `200 [{id,accountId,protocol,peerAddress,connectedAt,lastActivityAt}]` |
| `GET /ftp/accounts` | `cursor,limit` | `200 Page<FtpAccount>` |
| `POST /ftp/accounts` | `{name,mode,scope?,rootIds?,password?}` | `201 {account,password,endpoints}` |
| `GET /ftp/accounts/{id}` | 无 | `200 FtpAccount` |
| `PUT /ftp/accounts/{id}` | `{name,disabled,revision,scope?,rootIds?}` | `200 FtpAccount` |
| `PUT /ftp/accounts/{id}/password` | `{revision,password?}` | `200 {account,password,endpoints}` |
| `POST /ftp/accounts/{id}/password/reveal` | 无，要求最近五分钟内的 Passkey 登录 | `200 {name,password}` |
| `DELETE /ftp/accounts/{id}` | 无 | `204` |

账号 `mode` 取 `ftp`、`ftps` 或 `sftp`，各模式的账号独立。创建和换密码时可省略 `password` 生成随机值。列表和详情提供 `passwordChangedAt` 和 `passwordRetrievable`。配置加密密钥后，可用专门的 reveal 接口查看新设密码。过期登录返回 `403 fresh_passkey_required`。第一次设定密钥之前的账号需要轮换一次密码，旧密码仅有哈希。三种密码响应均为 `Cache-Control: no-store`。连接模式为 `plain`、`explicitTls`、`implicitTls` 和 `sftp`。修改账号授权、用户名、启用状态或密码会使旧连接失效。

`scope:"activeHomes"` 将所有在线、当前连接已授权且主目录根已启用的 Mac 映射为 `/mac1/`、`/mac2/` 等顶层目录。根内容是相应账号的 HOME 范围。挂载名根据首次公布的设备名称持久分配，重名附 UUID。此范围使用空的 `rootIds`。需要逐一授权时用 `scope:"grants"` 和指定的 `rootIds`，目录布局为 `/{deviceId}/{rootId}/`。创建时省略 `scope`，有 `rootIds` 则选择 `grants`，否则选择 `activeHomes`。两种范围均使用设备现有目录访问策略，文件网关开放目录浏览及下载。

SFTP 客户端首次连接时校验 `hostKeyFingerprint`，格式为 `SHA256:…`。启用监听且工作进程就绪时 `available:true`。连接运行 SFTP v3 文件子系统。文件下载固定到打开时的版本及 Mac 连接，目录读操作跨页校验版本。登录使用网关账号与密码，管理会话锁定期间已发放的网关账号照常工作。

```json
{"account":{"id":"fcd35110-9677-4fd7-83db-6f59cd838dc8","name":"download-ops","mode":"ftps","disabled":false,"revision":1,"rootIds":["84a38c77-f769-4e27-b6d0-331281675ebd"]},"password":"example-issued-secret","endpoints":[{"mode":"explicitTls","host":"filesharing.example.com","port":2122,"scheme":"ftp","address":"ftp://filesharing.example.com:2122/"}]}
```

## 遥测、诊断和审计

| 方法与路径 | 参数 / 请求体 | 响应 |
| --- | --- | --- |
| `GET /devices/D/status` | 无 | `200 {deviceId,connection,samples:[Snapshot]}` |
| `GET /devices/D/history` | `topic,after,limit,from,to` | `200 {items,cursor,hasMore}` |
| `POST /devices/D/refresh` | `{topics:[...]}` | `202 Job` |
| `GET /devices/D/apps/running` | 无 | `200 Snapshot` 运行程序 |
| `GET /devices/D/apps/installed` | 无 | `200 Snapshot` 安装清单 |
| `GET /devices/D/apps/icon` | `applicationId` 每个应用的 ID | `200 image/png` |
| `GET /devices/D/storage` | 无 | `200 Snapshot` 外接存储 |
| `POST /devices/D/diagnostics` | `{kind}`，`osVersion,uptime,diskSpace,agentHealth`，或 `{kind:"custom",command}` | `202 Job`，`Location` 指向作业 URL |
| `GET /jobs` | `cursor,limit,deviceId` | `200 Page<Job>` |
| `GET /jobs/{id}` | 无 | `200 Job` |
| `GET /jobs/{id}/output` | `after` 为上次收到的分片编号，初次传 `0` | `200 {items:[{index,stream,data}],cursor}` |
| `GET /events` | `deviceId,topic,after,limit,from,to` | `200 {items,cursor,hasMore}` |
| `GET /audit` | `cursor,limit,deviceId,action` | `200 Page<AuditRecord>` |
| `GET /health/live`、`GET /health/ready` | 无 | `200 {status:"live"}` 或 `200 {ready:true}` |

`from/to` 接收 ISO 8601，边界包含。应用事件使用 `applications.changed`，存储事件使用 `storage.changed`。审计游标为字符串序列，响应记录为 `{sequence,time,actor,deviceId,action,detail}`。快照结构为 `{topic,observedAt,stale,value}`，根据设备在线状态与采样时间计算 stale。作业可能为 `queued`、`completed`、`cancelled`、`failed`。

```json
{"id":"2204ec63-266b-45d3-8f67-8a088c744b21","deviceId":"144bae60-503d-45e3-8a17-ec7a64886c20","kind":"diagnostics.run","state":"completed","createdAt":"2026-11-19T08:22:00Z","finishedAt":"2026-11-19T08:22:01Z","result":{"stdout":"{\"seconds\":20188}","stderr":"","exitCode":0,"data":{"seconds":20188}},"error":null}
```

预设诊断对应 `/usr/bin/sw_vers`、`/usr/bin/uptime`、`/bin/df -k -l` 与 Agent 健康检查。Agent 0.4.1 起支持 `{"kind":"custom","command":"sysctl -n hw.model"}`，用空格或 Tab 分隔程序名和参数。命令最多 160 个字符、8 个参数。服务端和设备端分别校验，设备直接启动对应的系统程序。每台设备同时执行一项，使用当前用户身份。外部进程时限约 10 秒，每个输出流最多 16 KiB。自定义命令的结果 `data` 为 `null`，输出与退出码使用同一协议。

| 程序 | 可用参数 |
| --- | --- |
| `sw_vers` | 无，或一个 `-productName`、`-productVersion`、`-buildVersion` |
| `uptime`、`whoami` | 无 |
| `df` | `-h`、`-k`、`-l`，支持合并参数 |
| `uname` | `-a`、`-m`、`-n`、`-p`、`-r`、`-s`、`-v`，支持合并参数 |
| `date` | 无，或 `-u` |
| `pmset` | `-g`，可跟 `batt`、`cap`、`custom` 或 `therm` |
| `sysctl` | 可选 `-n`，后接一个或多个 `hw.model`、`hw.ncpu`、`hw.logicalcpu`、`hw.memsize`、`kern.osrelease`、`kern.osversion`、`machdep.cpu.brand_string` |

启动前订阅 `jobs.output` 和 `jobs.changed`。输出事件的 `payload` 形如 `{jobId,index,stream,data}`。编号从 1 递增，`stream` 是 `stdout` 或 `stderr`，`data` 是 Base64 编码的原始字节。分别增量解码两个流的 UTF-8 数据，按 `jobId,index` 去重。丢失 WS 或遇到编号间隙时用 `/jobs/{id}/output?after=...` 读取已保存的分片。诊断的 `jobs.changed` 完成事件附带 `exitCode`。可继续读取 `/jobs/{id}`，结果有 `stdout,stderr,exitCode,data,truncated,timedOut`。`completed` 表示设备返回了退出码，程序成功与否由 `exitCode` 判断。连接失效导致的 `failed` 保留已收到的分片。

## 原生对话框和本地通知

两个接口都要求 Passkey 会话和已授权的在线设备连接，并返回 `202 Job` 与作业位置。订阅 `jobs.changed` 接收完成提示，再读取 `GET /jobs/{id}`。WebSocket 不可用时轮询这个作业 API。

向 `POST /devices/D/interactions/dialogs` 发送以下请求。Agent 0.4.2 起使用应用自身图标，`icon` 可省略。选项 1–3 个，ID 必须唯一，使用 1–32 个英文字母、数字、横线或下划线。标题最多 100 字符，提示最多 1000 字符，按钮最多 40 字符。超时范围 10–120 秒，默认 90 秒。文本输入默认关闭，开启 `textRequired` 时先开启 `askText`。

```json
{"title":"维护确认","message":"请选择是否允许进入维护窗口，并填写原因。","choices":[{"id":"allow","label":"同意"},{"id":"deny","label":"暂缓"}],"askText":true,"textRequired":true,"timeoutSeconds":60}
```

应用使用独立进程在当前空间中置顶显示单个 260 pt 宽的原生面板。面板包含应用图标、标题、提示、可选说明框和按钮。首选项为默认按钮，可用 Escape 或关闭按钮取消。每台设备同时展示一个请求。作业的 `result` 为 `{outcome,choiceId,text,respondedAt}`，结果 `submitted` 携带选择与最多 1024 字符的说明，`dismissed` 和 `expired` 的选择与说明为空。已锁定、已注销或退出当前用户的 Mac 不能答复。取消管理会话、撤销远程授权或设备断线会结束进行中的显示。客户端会回收超时或出错的弹窗进程。

选项需要本机身份验证时，使用 `requireLocalAuthentication:true`，并省略 `askText` 和 `textRequired`。选择选项后，macOS 使用系统窗口验证设备所有者。密码与 Touch ID 均由系统处理。验证通过时，结果额外包含 `locallyAuthenticated:true`，`text` 为 `null`。 [Apple LocalAuthentication](https://developer.apple.com/documentation/LocalAuthentication/LAPolicy/deviceOwnerAuthentication)

向 `POST /devices/D/interactions/notifications` 提交 `{"title":"维护提醒","message":"18:00 开始维护。","sound":false}`。标题最多 100 字符，正文最多 500 字符，声音默认关闭。用户先在已安装 App 选择「启用本地通知」。成功的 `result` 为 `{status:"scheduled",scheduledAt}`，表示系统接受本地通知，展示行为遵从 macOS 设置。未获授权时作业失败并给出 `notification_permission_required`。

## WebSocket 订阅

连接 `GET /api/v1/events/ws`，携带同源 Cookie 和 Origin。服务器先发送 `ready`。客户端为每个订阅选一个 1–64 字符的 `id`。订阅所收事件带同一个 id，可按 `sequence` 去重。每条连接最多 16 个订阅。

```json
{"type":"ready","cursor":"1202"}
```

```json
{"type":"subscribe","id":"browse-folder","deviceId":"144bae60-503d-45e3-8a17-ec7a64886c20","topic":"files.changed","rootId":"84a38c77-f769-4e27-b6d0-331281675ebd","path":"project"}
```

```json
{"type":"subscribed","id":"browse-folder","cursor":"1202","snapshotRequired":true}
```

```json
{"type":"event","id":"browse-folder","item":{"sequence":"1203","deviceId":"144bae60-503d-45e3-8a17-ec7a64886c20","topic":"files.changed","time":"2026-11-19T08:22:00Z","payload":{"watchId":"93327b87-7c53-4a91-85c3-78105b3916b8","rootId":"84a38c77-f769-4e27-b6d0-331281675ebd","path":"project","change":{"watchId":"93327b87-7c53-4a91-85c3-78105b3916b8","kind":"delta","previousRevision":"directory-snapshot","revision":"directory-snapshot-next","changes":[{"kind":"renamed","fromPath":"project/plan.pdf","entry":{"name":"revised.pdf","path":"project/revised.pdf","kind":"file","version":"next-version"}}]}}}}
```

```json
{"type":"unsubscribe","id":"browse-folder"}
```

```json
{"type":"unsubscribed","id":"browse-folder"}
```

普通主题包括所有[设备样本及事件](telemetry.md)。连接后可在 subscribe 传 `after` 续收历史。遇到 WebSocket 断线时用 `GET /events?deviceId=D&topic=...&after=...` 读取同一游标之后的事件，逐页读取到 `hasMore:false`。若服务端返回 `410 resync_required`，读取最新快照并重新订阅。错误帧为 `{type:"error",id,code}`。管理会话撤销后服务器以 1008 关闭。

目录订阅使用 `added`、`removed`、`updated`、`renamed`，或者 `change.kind:"resync_required"`。目录初订阅和重连须拉取新的 REST 快照。事件前置版本与当前快照不符时也重新读取。目录变更经 WebSocket 投递，失去 WebSocket 时可通过 REST 周期拉取目录。这一机制允许授权撤销立即停止目录推送。
