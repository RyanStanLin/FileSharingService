import {blankRow, bytes, dateText, duration, element, eventRow, eventSocket, facts, node, row, stack, status} from "./ui.js"

const telemetryTopics = ["identity", "cpu", "memory", "disk", "battery", "power", "system", "displays", "locale", "network", "agent", "lid", "storage"]
const liveTelemetryTopics = telemetryTopics.filter(topic => topic !== "locale")
const appTopics = ["apps-running", "apps-installed"]
const eventTopics = {telemetry: ["lid.changed", "clipboard.changed", "storage.changed", "system.changed"], apps: ["applications.changed"]}
const sampling = [
    ["cpu", "CPU"], ["memory", "内存"], ["disk", "磁盘"], ["battery", "电池"], ["displays", "显示器"],
    ["network", "网络"], ["system", "系统"], ["power", "电源"], ["agent", "Agent"], ["storage", "外接存储"], ["appsRunning", "运行中应用"]
]
const lidStates = {active: "保持唤醒已生效", idle: "辅助服务空闲", powerGuard: "电源条件限制",
    externallyManaged: "由其他策略管理", unsupported: "设备不支持", systemControlled: "由 macOS 管理",
    restoreFailed: "恢复失败", stateUnavailable: "状态不可用", testIsolated: "隔离测试模式"}
const changes = {launched: "启动", terminated: "退出", activated: "切到前台", deactivated: "离开前台",
    hidden: "隐藏", unhidden: "取消隐藏", installed: "安装", removed: "移除", updated: "更新",
    inserted: "插入", mounted: "挂载", unmounted: "卸载"}
const lockStates = {locked: "已锁定", unlocked: "已解锁"}
const sleepStates = {awake: "唤醒", sleeping: "睡眠"}
const healthStates = {healthy: "正常"}
const closedText = value => typeof value === "boolean" ? value ? "已合盖" : "已开盖" : "未报告"
const boolText = (value, yes, no) => value == null ? "—" : value ? yes : no
const percent = value => Number.isFinite(value) ? value.toLocaleString("zh-CN", {maximumFractionDigits: 1}) + "%" : "—"
const appPageSize = 25

export function deviceData({call, perform, submitCollection}) {
    let view
    let activePane
    const fields = new Map(sampling.map(([key, label]) => {
        const field = node("input")
        field.type = "number"
        field.id = "sample-" + key
        field.min = "0"
        field.max = "3600"
        field.step = "1"
        field.required = true
        field.addEventListener("input", () => field.setCustomValidity(""))
        const control = node("label", label)
        control.append(field)
        element("sampling-fields").append(control)
        return [key, field]
    }))

    function path(state, suffix) {
        return "/devices/" + encodeURIComponent(state.id) + suffix
    }

    function bind(device, pane) {
        const targetPane = pane === "telemetry" || pane === "apps" ? pane : undefined
        const changedDevice = device?.id !== view?.id
        if (changedDevice) {
            closeFeed(view)
            view?.controller.abort()
            view = device && {id: device.id, device, controller: new AbortController(), samples: new Map(),
                versions: new Map(), cursors: new Map(), events: {apps: [], telemetry: []},
                observedSince: new Date().toISOString(), loading: new Set(), appPage: 0}
            element("device-policy").reset()
            element("policy-source").textContent = ""
            status("policy-status", "")
            element("apps-filter").value = ""
            renderTelemetry(view)
            renderApps(view)
            renderEvents(view, "telemetry")
            renderEvents(view, "apps")
        }
        if (activePane !== targetPane || changedDevice) {
            closeFeed(view)
            activePane = targetPane
            if (activePane) status(activePane + "-feed", device?.connection.online ? "正在同步…" : device ? "离线 · 最近快照" : "等待设备上线")
            if (view && activePane) {
                const state = view
                openFeed(state)
                void perform(() => synchronize(state, activePane, true))()
                if (activePane === "telemetry" && !state.policy) void perform(() => loadPolicy(state))()
            }
        }
        if (!view) {
            element("policy-fields").disabled = true
            return
        }
        const changedConnection = view.device.connection.connectionId !== device.connection.connectionId
        const changedAccess = view.accessGranted !== device.connection.accessGranted
        view.device = device
        view.accessGranted = device.connection.accessGranted
        if (changedAccess && activePane === "apps") scheduleRender(view)
        if (changedConnection && activePane) {
            closeFeed(view)
            openFeed(view)
            void perform(() => synchronize(view, activePane, true))()
        }
        element("policy-fields").disabled = !view.policy || view.policyBusy === true
        element("inherit-policy").disabled = view.policy?.inherited === true
    }

    function closeFeed(state) {
        if (!state) return
        const previous = state.socket
        state.socket = undefined
        state.subscriptions = undefined
        state.reconnectAt = 0
        previous?.close()
    }

    function openFeed(state) {
        if (!activePane || !state?.device.connection.online || state.socket || Date.now() < (state.reconnectAt ?? 0)) return
        const pane = activePane
        const topics = [...(pane === "telemetry" ? liveTelemetryTopics : appTopics), ...eventTopics[pane]]
        const socket = eventSocket()
        state.socket = socket
        state.subscriptions = new Set()
        socket.addEventListener("message", ({data}) => {
            if (view !== state || state.socket !== socket) return
            const frame = JSON.parse(data)
            if (frame.type === "ready") {
                for (const topic of topics) {
                    socket.send(JSON.stringify({type: "subscribe", id: topic, deviceId: state.id, topic,
                        after: state.cursors.get(topic) ?? frame.cursor}))
                }
            } else if (frame.type === "subscribed") {
                state.subscriptions.add(frame.id)
                if (state.subscriptions.size === topics.length) status(pane + "-feed", "WebSocket 直播")
            } else if (frame.type === "event") {
                receive(state, pane, frame.item)
            } else if (frame.type === "error") {
                state.cursors.delete(frame.id)
                socket.close()
            }
        })
        socket.addEventListener("close", () => {
            if (view !== state || state.socket !== socket) return
            closeFeed(state)
            state.reconnectAt = Date.now() + 5000
            status(pane + "-feed", "REST 回退")
            void perform(() => synchronize(state, pane, true))()
        })
    }

    function receive(state, pane, item) {
        if (item.deviceId !== state.id) return
        const last = state.cursors.get(item.topic)
        if (last && BigInt(item.sequence) <= BigInt(last)) return
        state.cursors.set(item.topic, item.sequence)
        if (eventTopics[pane].includes(item.topic)) {
            const events = state.events[pane]
            events.push(item)
            events.sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? 1 : -1)
            events.length = Math.min(events.length, 60)
            renderEvents(state, pane)
        } else {
            state.versions.set(item.topic, item.sequence)
            state.samples.set(item.topic, {topic: item.topic, value: item.payload, observedAt: item.time, stale: false})
            scheduleRender(state)
        }
    }

    function scheduleRender(state) {
        if (state.framePending) return
        state.framePending = true
        requestAnimationFrame(() => {
            state.framePending = false
            if (view !== state) return
            if (activePane === "telemetry") renderTelemetry(state)
            if (activePane === "apps") renderApps(state)
        })
    }

    async function synchronize(state, pane, readEvents = false) {
        if (!state || !pane || state.loading.has(pane)) return
        state.loading.add(pane)
        const options = {signal: state.controller.signal}
        const initialVersions = new Map(state.versions)
        const optional = suffix => call(path(state, suffix), options).catch(error => {
            if (error.status !== 404) throw error
        })
        try {
            const samples = pane === "telemetry"
                ? await Promise.all([call(path(state, "/status"), options), optional("/storage")])
                      .then(([details, storage]) => [...details.samples, storage])
                : await Promise.all([optional("/apps/running"), optional("/apps/installed")])
            if (view !== state) return
            for (const sample of samples) {
                if (sample && initialVersions.get(sample.topic) === state.versions.get(sample.topic))
                    state.samples.set(sample.topic, sample)
            }
            scheduleRender(state)
            if (readEvents) await Promise.all(eventTopics[pane].map(topic => readHistory(state, pane, topic)))
        } finally {
            state.loading.delete(pane)
        }
    }

    async function readHistory(state, pane, topic) {
        // Bound each refresh; the next tick continues the cursor if a device emits a burst.
        for (let pageNo = 0; pageNo < 3 && view === state; pageNo++) {
            const query = new URLSearchParams({topic, from: state.observedSince, limit: "80"})
            const after = state.cursors.get(topic)
            if (after) query.set("after", after)
            const page = await call(path(state, "/history?") + query, {signal: state.controller.signal}).catch(error => {
                if (error.status !== 410) throw error
                if (state.cursors.get(topic) === after) state.cursors.delete(topic)
            })
            if (!page) continue
            for (const item of page.items) if (view === state) receive(state, pane, item)
            if (!page.hasMore) return
        }
    }

    async function tick() {
        const state = view
        if (!state || !activePane) return
        if (!state.device.connection.online && state.socket) closeFeed(state)
        openFeed(state)
        const targets = activePane === "telemetry" ? liveTelemetryTopics : appTopics
        if (state.subscriptions?.size !== targets.length + eventTopics[activePane].length) {
            status(activePane + "-feed", state.device.connection.online ? "REST 回退" : "离线 · 最近快照")
            await synchronize(state, activePane, true)
        }
    }

    function renderTelemetry(state) {
        const value = topic => state?.samples.get(topic)?.value
        const cpu = value("cpu"), memory = value("memory"), battery = value("battery"), power = value("power")
        const lid = value("lid")?.lidClosed ?? power?.closedLid?.lidClosed
        const identity = value("identity"), system = value("system"), network = value("network"), agent = value("agent"), locale = value("locale")
        const displays = value("displays")
        const resolutions = (Array.isArray(displays?.items) ? displays.items : []).flatMap(display =>
            Number.isSafeInteger(display?.width) && Number.isSafeInteger(display?.height) && display.width > 0 && display.height > 0
                ? [`${display.width} × ${display.height} px`] : [])
        element("telemetry-summary").replaceChildren(...[
            ["CPU 使用率", percent(cpu?.usagePercent), cpu?.usagePercent],
            ["内存使用率", percent(memory?.usagePercent), memory?.usagePercent],
            ["电池", percent(battery?.chargePercent), battery?.chargePercent],
            ["盖状态", closedText(lid)]
        ].map(([label, text, amount]) => {
            const item = node("div")
            const definition = node("dd", text)
            if (Number.isFinite(amount)) {
                const meter = node("meter")
                meter.max = 100
                meter.value = amount
                meter.setAttribute("aria-label", label)
                definition.append(meter)
            }
            item.append(node("dt", label), definition)
            return item
        }))
        facts("system-details", [
            ["设备", identity?.name ?? state?.device.name], ["UUID", state?.id], ["主机名 / 用户", join(identity?.hostname, identity?.username)],
            ["系统版本", join(identity?.osVersion, identity?.osBuild)], ["型号", identity?.model], ["处理器", join(identity?.cpuModel, identity?.architecture, identity?.cores && identity.cores + " 核")],
            ["显示器分辨率", join(...resolutions)],
            ["语言 / 时区 / 地区", join(locale?.language, locale?.timeZone, locale?.region)],
            ["开机时间", dateText(system?.bootedAt)], ["运行时长", duration(system?.uptimeSeconds)], ["锁屏", lockStates[system?.lockState] ?? "未报告"],
            ["Agent", join(agent?.version, healthStates[agent?.health] ?? agent?.health, duration(agent?.uptimeSeconds))]
        ])
        facts("resource-details", [
            ["内存总量", bytes(memory?.totalBytes)], ["已用 / 可用", join(bytes(memory?.usedBytes), bytes(memory?.availableBytes))],
            ["供电", boolText(battery?.externalPower ?? power?.externalPower, "外接电源", "电池供电")],
            ["电池充电", boolText(battery?.charging, "正在充电", "未充电")], ["低电量模式", boolText(power?.lowPowerMode, "开启", "关闭")],
            ["网络可达性", {reachable: "可达", unavailable: "不可达"}[network?.reachability] ?? "未报告"],
            ["主网卡", network?.primaryInterface],
            ["代理", network?.proxy && (network.proxy.http || network.proxy.https || network.proxy.automatic ? "已配置" : "关闭")],
            ["VPN", {tunnelObserved: "检测到隧道", noTunnelObserved: "未检测到隧道"}[network?.vpn?.state]],
            ["显示器数量", displays?.count]
        ])
        facts("power-details", [
            ["盖状态", closedText(lid)], ["Mac 收到的策略", boolText(power?.configured, "请求保持唤醒", "遵循默认睡眠")],
            ["合盖辅助服务", lidStates[power?.closedLid?.state] ?? "未报告"],
            ["空闲睡眠断言", boolText(power?.idleAssertionActive, "生效", "未生效")],
            ["系统 / 显示器", join(sleepStates[power?.sleepState], boolText(power?.displaySleeping, "显示器睡眠", "显示器唤醒"))],
            ["最近采样", dateText(state?.samples.get("power")?.observedAt)]
        ])
        const drives = [...(value("disk") ?? []).map(disk => row(disk.mountPath, disk.type, bytes(disk.totalBytes), bytes(disk.availableBytes), "已挂载")),
            ...(value("storage") ?? []).map(disk => row(stack(disk.name ?? disk.id, disk.mountPath, disk.transport), disk.fileSystem,
                bytes(disk.capacityBytes), bytes(disk.remainingBytes), disk.mountPath ? "外接 · 已挂载" : "外接 · 已连接"))]
        element("storage-rows").replaceChildren(...(drives.length ? drives : [blankRow("等待磁盘样本", 5)]))
        element("raw-telemetry").textContent = state?.samples.size
            ? JSON.stringify(telemetryTopics.flatMap(topic => state.samples.has(topic) ? [state.samples.get(topic)] : []), null, 2) : "暂无样本"
    }

    function renderApps(state) {
        const sample = state?.samples.get(element("apps-mode").value)
        const search = element("apps-filter").value.trim().toLowerCase()
        const all = sample?.value ?? []
        const items = all.filter(app => [app.name, app.bundleId, app.pid].some(value => String(value ?? "").toLowerCase().includes(search)))
        if (state) state.appPage = Math.min(state.appPage, Math.max(0, Math.ceil(items.length / appPageSize) - 1))
        const start = (state?.appPage ?? 0) * appPageSize
        const page = items.slice(start, start + appPageSize)
        element("app-rows").replaceChildren(...(page.length ? page.map(app => {
            const identity = stack(app.name ?? "未命名应用", app.bundleId)
            if (app.iconHash && app.applicationId && state.device.connection.accessGranted) {
                const icon = node("a", "图标 PNG")
                icon.href = "/api/v1" + path(state, "/apps/icon?") + new URLSearchParams({applicationId: app.applicationId})
                icon.target = "_blank"
                icon.rel = "noopener"
                icon.title = "SHA-256 " + app.iconHash
                identity.append(icon)
            }
            const flags = [app.foreground && "前台", app.active && "活动", app.hidden && "隐藏"].filter(Boolean)
            return row(identity, stack(app.version ?? "—", app.pid != null ? "PID " + app.pid : undefined),
                app.pid == null ? "—" : stack(flags.join(" · ") || "后台", dateText(app.launchedAt), duration(app.uptimeSeconds)),
                stack(app.installPath ?? "—", app.executablePath))
        }) : [blankRow(sample ? search ? "未找到匹配的应用" : "清单为空" : "等待设备上报应用清单", 4)]))
        element("apps-count").textContent = sample
            ? (items.length ? (start + 1) + "–" + (start + page.length) + " / " : "") + items.length + " 项 · " + dateText(sample.observedAt)
            : ""
        element("apps-previous").disabled = start === 0
        element("apps-next").disabled = start + page.length >= items.length
    }

    function renderEvents(state, pane) {
        const items = state?.events[pane] ?? []
        const root = pane === "apps" ? "app-events" : "device-events"
        element(root + "-empty").hidden = items.length > 0
        element(root).replaceChildren(...items.map(({topic, payload, time}) => {
            if (topic === "clipboard.changed") return eventRow(payload.occurredAt ?? time, "剪贴板已更新", "仅时间")
            if (topic === "lid.changed") return eventRow(payload.occurredAt ?? time, "盖状态", closedText(payload.lidClosed))
            if (topic === "system.changed") return eventRow(payload.occurredAt ?? time,
                {sleeping: "系统睡眠", woke: "系统唤醒", networkPath: "网络变化"}[payload.kind] ?? payload.kind,
                {reachable: "可达", unavailable: "不可达"}[payload.reachability])
            const details = payload.application ?? payload.storage ?? {}
            return eventRow(payload.occurredAt ?? time, changes[payload.kind] ?? payload.kind,
                join(details.name ?? details.bundleId ?? details.id, details.pid != null ? "PID " + details.pid : details.mountPath ?? details.lastMountPath) ?? "—")
        }))
    }

    async function loadPolicy(state) {
        if (!state || state.policyBusy) return
        state.policyBusy = true
        element("policy-fields").disabled = true
        try {
            const policy = await call(path(state, "/policy"), {signal: state.controller.signal})
            if (view === state) showPolicy(state, policy)
        } finally {
            state.policyBusy = false
            if (view === state) element("policy-fields").disabled = !state.policy
        }
    }

    function showPolicy(state, policy) {
        state.policy = policy
        element("keep-awake").checked = policy.settings.keepAwake
        for (const [key, field] of fields) {
            field.value = policy.settings[key] ?? 0
            field.setCustomValidity("")
        }
        element("policy-source").textContent = policy.inherited ? "继承采样配置" : "设备独立策略"
        element("inherit-policy").disabled = policy.inherited
    }

    async function savePolicy(inherit) {
        const state = view
        if (!state?.policy || state.policyBusy) return
        const settings = {...state.policy.settings, keepAwake: element("keep-awake").checked}
        if (!inherit) {
            for (const [key, field] of fields) {
                const interval = field.valueAsNumber
                if (!Number.isInteger(interval) || (interval !== 0 && (interval < 5 || interval > 3600))) {
                    field.setCustomValidity("请输入 0 或 5–3600 的整数。")
                    field.reportValidity()
                    return
                }
                settings[key] = interval
            }
        }
        state.policyBusy = true
        element("policy-fields").disabled = true
        status("policy-status", "正在保存…")
        try {
            const policy = await call(path(state, "/policy"), {method: "PUT", signal: state.controller.signal,
                body: {revision: state.policy.revision, settings: inherit ? null : settings}})
            if (view !== state) return
            showPolicy(state, policy)
            status("policy-status", inherit ? "已恢复继承。" : "已保存设备策略。等待 Mac 回报。")
        } catch (error) {
            if (view === state && error.name !== "AbortError")
                status("policy-status", error.status === 409 ? "策略已被更新。请重新读取，再保存。" : error.message, true)
        } finally {
            state.policyBusy = false
            if (view === state) element("policy-fields").disabled = false
        }
    }

    element("collect-telemetry").addEventListener("click", perform(() => submitCollection(telemetryTopics)))
    element("device-policy").addEventListener("submit", perform(() => savePolicy(false)))
    element("inherit-policy").addEventListener("click", perform(() => savePolicy(true)))
    element("reload-policy").addEventListener("click", perform(async () => { await loadPolicy(view); status("policy-status", "") }))
    for (const [id, event, action] of [["apps-mode", "change", () => 0], ["apps-filter", "input", () => 0],
        ["apps-previous", "click", value => value - 1], ["apps-next", "click", value => value + 1]]) {
        element(id).addEventListener(event, () => {
            if (!view) return
            view.appPage = Math.max(0, action(view.appPage))
            renderApps(view)
        })
    }
    element("clear-app-events").addEventListener("click", () => {
        if (view) view.events.apps = []
        renderEvents(view, "apps")
    })

    return {bind, tick, refresh: async () => {
        const state = view, pane = activePane
        if (state && pane === "telemetry" && !state.policy) await loadPolicy(state)
        await synchronize(state, pane, true)
    }}
}

function join(...values) {
    const parts = values.filter(value => value != null && value !== "")
    return parts.length ? parts.join(" · ") : undefined
}
