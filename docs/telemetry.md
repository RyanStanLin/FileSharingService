# 设备状态结构

`GET /api/v1/devices/{id}/status` 返回 `connection` 与多个 `samples`。每条样本为 `{topic,observedAt,stale,value}`。`observedAt` 是服务端接收时间。应用、存储及系统事件的 `occurredAt` 来自设备时钟。未知字段保留 `null` 或 `unknown`。

连接有 `online,protocol,connectedAt,lastCommunicationAt,latencyMs,connectionSeconds,connectionId,accessGranted,peerAddress`。实际关闭连接时立即更新在线状态。对无响应连接用单调时钟计算最近 45 秒活动。协议为 `wss` 或 `https`。断线后保留最后通信时间和最近样本。

客户端连接执行器独立处理心跳、发送和重连。HTTPS 轮询会在近期仍有成功通信时重试短暂请求失败。设备重连后分配新的 `connectionId`，操作员可以为新连接授权。

| topic | value |
| --- | --- |
| `identity` | `name,hostname,username,osVersion,osBuild,model,cpuModel,architecture,cores`。设备 UUID 在外层。 |
| `cpu` | `usagePercent`。 |
| `memory` | `totalBytes,usedBytes,availableBytes,usagePercent`。依据 macOS VM 页估算。 |
| `disk` | 挂载点数组，每项 `mountPath,type,totalBytes,usedBytes,availableBytes`。 |
| `battery` | `externalPower,chargePercent,charging`。没有内置电池时百分比为空。 |
| `power` | `configured,idleAssertionActive,closedLid,lowPowerMode,sleepState,externalPower,displaySleeping,lockState,displayAndLockPolicy`。 |
| `system` | `uptimeSeconds,bootedAt,sleepState,displaySleeping,lockState,lockStateQuality`。锁屏状态来自用户会话通知。 |
| `displays` | `count,items`。单项 `id,width,height,refreshRateHz,builtIn,active`。可变刷新率可能没有固定值。 |
| `locale` | `language,timeZone,region`。 |
| `network` | `interfaces,proxy,vpn,reachability,primaryInterface`。网卡含 `name,address,family,up,loopback`。VPN 根据隧道接口上报 `noTunnelObserved` 或 `tunnelObserved`。 |
| `agent` | `version,startedAt,uptimeSeconds,health`。 |
| `apps-running` | 应用清单加 `pid,launchedAt,uptimeSeconds,foreground,active,hidden,iconHash`。可用时 `iconHash` 为图标 PNG 的 SHA-256 十六进制值，与图标接口的 ETag 一致。 |
| `apps-installed` | 应用清单，单项 `applicationId,name,bundleId,version,build,installPath,executablePath`。应用图标端点的 PNG 具有 SHA-256 ETag。 |
| `storage` | 外接存储清单，单项 `id,name,capacityBytes,remainingBytes,fileSystem,mountPath,status,connected,transport,wholeDisk`。ID 为当前连接可见的 BSD 名称。 |
| `lid` | `{lidClosed}`，布尔值。设备没有提供合盖状态时为 `null`。 |
| `permissions` | 以 `downloads,documents,desktop,inputMonitoring,pasteboard` 为键，每项为 `{state,phase,checkedAt,systemSettingsPane}`。Agent 0.4.7 起，目录检查另返回 `writable`，表示目标 Mac 已确认目录可写。 |
| `roots` | 本机目录策略数组，每项 `rootKey,label,writable,primary`。 |

`power.closedLid` 带 `state,configuredByHelper,lidClosed`，辅助服务有新报告时另有 `sleepDisabled,checkedAt`。状态支持 `active`、`idle`、`powerGuard`、`externallyManaged`、`unsupported`、`systemControlled`、`restoreFailed`、`stateUnavailable`，本地隔离测试使用 `testIsolated`。发现设备运行中断时结合最后通信时间判断。

| event topic | payload |
| --- | --- |
| `connection.changed` | 更新后的连接对象。 |
| `connection.quality` | 同一连接对象，携带心跳 RTT、最近通信时间与连接时长，约每 5 秒推送。以前端当前 `connectionId` 丢弃旧连接的心跳。 |
| `applications.changed` | `{kind,application,occurredAt}`。kind 为 `launched,terminated,activated,deactivated,hidden,unhidden,installed,removed,updated`。 |
| `storage.changed` | `{kind,storage,occurredAt}`。kind 为 `inserted,removed,mounted,unmounted`。移除或卸载时，先前的挂载点保存在 `storage.lastMountPath`。 |
| `system.changed` | 设备休眠、唤醒和网络可达性变化。 |
| `lid.changed` | `{lidClosed,occurredAt}`。运行期间以约 500 毫秒的间隔观察 IOKit 盖状态。睡眠期间由 macOS 暂停进程，唤醒后重新采样。 |
| `clipboard.changed` | `{occurredAt}`。客户端约每 500 毫秒比较一次本地所有权计数，发送发现变化的时间。采样间隔内的多次变化可能合并。 |
| `telemetry.gap` | 客户端待发送事件超过保留上限。 |
| `files.changed` | 目录增量或重新同步信号。 |
| `windows.changed` | 最新窗口快照。WS 使用窗口修订 UUID，REST 回退使用 `/devices/D/windows`。 |
| `jobs.changed` | `{id,state,kind}`，诊断进程返回退出码时附带 `exitCode`。 |
| `jobs.output` | `{jobId,index,stream,data}`，诊断标准输出或错误流分片。 |
| `transfers.changed` | `{id,state,offset,length}`。 |

剪贴板实现见 [ClipboardObserver.swift](../src/Mac/ClipboardObserver.swift) 与 [AgentTransport.swift](../src/Mac/AgentTransport.swift)。剪贴板载荷仅含 ISO 8601 时间，服务端在写库前校验唯一字段并重新序列化。服务器添加设备 ID 和事件序号。初次观测只建立本机基线。客户端仅在内存排队，服务端使用通用事件保留期限。

窗口观察按需启动。存在 WS 订阅或 REST 请求时，服务端按设备连接合并并续期 20 秒采集租约。Agent 在独立队列约每 250 毫秒采样，窗口属性或 Foreground 变化时上报最新完整快照。服务端只在内存保留当前租约内的最新值。实际更新延迟包含采样、设备传输与浏览器订阅投递。 [窗口接口和字段](api.md#窗口实时状态)

策略采样间隔支持 5–3600 秒或 `0`。设为 `0` 后可以调用刷新 API，系统事件仍会更新相关样本。应用启动和退出通过 `NSWorkspace.runningApplications` 的 KVO 发现，包括 AppKit 注册的后台 App。安装事件来自 FSEvents 触发的安装目录对账，另有周期重扫。清单覆盖 `/Applications`、`/System/Applications`、`~/Applications` 内的 App 包。 [Apple AppKit](https://developer.apple.com/documentation/appkit/nsworkspace/runningapplications)

字段与请求方法见 [API](api.md)。事件协议见 [AsyncAPI](asyncapi.yaml)。
