# 设备状态结构

`GET /api/v1/devices/{id}/status` 返回 `connection` 与多个 `samples`。每条样本为 `{topic,observedAt,stale,value}`。`observedAt` 是服务端接收时间。应用、存储及系统事件的 `occurredAt` 来自设备时钟。未知字段保留 `null` 或 `unknown`。

连接有 `online,protocol,connectedAt,lastCommunicationAt,latencyMs,connectionSeconds,connectionId,accessGranted,peerAddress`。在线由最近 45 秒通信判断。协议为 `wss` 或 `https`。断线后保留最后通信时间和最近样本。

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
| `network` | `interfaces,proxy,vpn`。网卡含 `name,address,family,up,loopback`。VPN 根据隧道接口上报 `noTunnelObserved` 或 `tunnelObserved`。 |
| `agent` | `version,startedAt,uptimeSeconds,health`。 |
| `apps-running` | 应用清单加 `pid,launchedAt,uptimeSeconds,foreground,active,hidden`。 |
| `apps-installed` | 应用清单，单项 `applicationId,name,bundleId,version,build,installPath,executablePath`。应用图标端点的 PNG 具有 SHA-256 ETag。 |
| `storage` | 外接存储清单，单项 `id,name,capacityBytes,remainingBytes,fileSystem,mountPath,status`。ID 为当前连接可见的 BSD 名称。 |
| `permissions` | 以 `downloads,documents,desktop,inputMonitoring,pasteboard` 为键，每项为 `{state,phase,checkedAt,systemSettingsPane}`。 |
| `roots` | 本机目录策略数组，每项 `rootKey,label,writable,primary`。 |

`power.closedLid` 带 `state,configuredByHelper,lidClosed`，辅助服务有新报告时另有 `sleepDisabled,checkedAt`。状态支持 `active`、`idle`、`powerGuard`、`externallyManaged`、`unsupported`、`systemControlled`、`restoreFailed`、`stateUnavailable`，本地隔离测试使用 `testIsolated`。发现设备运行中断时结合最后通信时间判断。

| event topic | payload |
| --- | --- |
| `connection.changed` | 更新后的连接对象。 |
| `applications.changed` | `{kind,application,occurredAt}`。kind 为 `launched,terminated,activated,deactivated,hidden,unhidden,installed,removed,updated`。 |
| `storage.changed` | `{kind,storage,occurredAt}`。kind 为 `inserted,removed,mounted,unmounted`。 |
| `system.changed` | 设备休眠、唤醒和网络可达性变化。 |
| `telemetry.gap` | 客户端待发送事件超过保留上限。 |
| `files.changed` | 目录增量或重新同步信号。 |
| `jobs.changed` | `{id,state,kind}`。 |
| `transfers.changed` | `{id,state,offset,length}`。 |

字段与请求方法见 [API](api.md)。事件协议见 [AsyncAPI](asyncapi.yaml)。
