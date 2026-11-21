import {deviceData} from "./device-data.js"
import {deviceJobs} from "./device-jobs.js"
import {gatewayPanel} from "./gateway.js"
import {dateText, duration, element, eventSocket, status} from "./ui.js"

const permissions = [
    ["downloads", "下载目录"],
    ["documents", "文稿目录"],
    ["desktop", "桌面目录"],
    ["inputMonitoring", "输入监控"],
    ["pasteboard", "剪贴板"]
]
const statuses = { notDetermined: "未检测", allowed: "已授权", denied: "已拒绝",
    requiresSystemSettings: "需系统设置", unavailable: "不可用", unknown: "未知" }
const errors = { authentication_required: "请先解锁后台。",
    agent_connection_access_required: "请先授权当前设备连接。",
    agent_connection_changed: "设备已重连，请重新授权当前连接。",
    agent_connection_ended: "设备连接已中断，本次操作未返回结果。",
    device_unavailable: "设备连接已中断，本次操作未返回结果。",
    device_timeout: "设备未在规定时间内回报。",
    permission_denied: "设备的共享策略或文件系统拒绝了这次访问。",
    filesystem_access_denied: "macOS 拒绝了目标路径的访问。请核对 FileSharingService 的系统目录权限。",
    root_identity_changed: "共享目录的卷或目录身份已变化。请在 Mac 上确认目录并重新批准该共享根。",
    root_access_denied: "当前连接没有此目录授权。",
    not_found: "当前目录或文件不存在。",
    snapshot_unavailable: "设备状态正在同步。",
    limit_reached: "刚发出过同项申请，请稍后重试。",
    interactive_session_required: "请先让 Mac 登录并解锁当前用户会话。",
    interaction_already_running: "这台 Mac 已有对话框在等待答复。",
    dialog_presentation_failed: "Mac 对话框显示失败。可以重新发送。",
    local_authentication_unavailable: "这台 Mac 当前无法进行系统身份验证。",
    diagnostic_already_running: "这台 Mac 上已有诊断在运行。",
    diagnostic_command_blocked: "服务端策略已禁用此诊断。",
    invalid_diagnostic_command: "请输入受支持的只读命令及参数，例如 uname -m。",
    unsupported: "设备当前版本不支持这项操作。",
    job_limit: "当前操作过多，请稍后重试。",
    review_ended: "当前 Passkey 管理会话已结束。",
    invalid_ftp_password: "密码需为 16–128 个可打印 ASCII 字符，至少 8 个不同字符，并同时包含字母和非字母。",
    account_name_in_use: "该用户名已被使用。",
    invalid_account_name: "用户名只可使用英文字母、数字、点、横线和下划线。",
    password_reveal_unavailable: "当前账号没有可查询的密码，请先轮换。",
    ftp_mode_disabled: "当前服务未启用该协议。"
}
const errorText = code => errors[code] ?? code
const sortButtons = document.querySelectorAll("[data-sort]")
const fileTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"
})
const byteFormat = new Intl.NumberFormat("zh-CN", {maximumFractionDigits:1})
const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
const thumbnailQueue = []
const activeThumbnails = new Set()
const thumbnailObserver = new IntersectionObserver(items => {
    for (const {isIntersecting, target} of items) {
        if (!isIntersecting) continue
        thumbnailObserver.unobserve(target)
        thumbnailQueue.push(target)
    }
    loadThumbnails()
}, {rootMargin:"160px 0px"})

let unlocked = false
let devices = []
let deviceId
let snapshot = {}
let socket
let pendingJobs = new Map()
let directory
let sortKey = "name"
let sortDirection = "asc"
let refreshInProgress = false
let jobPollInProgress = false
let pane = "files"
const tabs = [...document.querySelectorAll("[data-pane]")]
const jobs = deviceJobs({call, perform, errorText, collectCompleted: () => data.refresh()})
const data = deviceData({call, perform, submitCollection: topics => jobs.collect(topics)})
const gateway = gatewayPanel({call, perform, authenticate})

function updatePanes() {
    const device = unlocked ? selected() : undefined
    data.bind(device, pane)
    jobs.bind(device)
    gateway.bind(unlocked && pane === "gateway")
}

function selectPane(tab) {
    pane = tab.dataset.pane
    for (const item of tabs) {
        const active = item === tab
        item.setAttribute("aria-selected", String(active))
        item.tabIndex = active ? 0 : -1
        element(item.getAttribute("aria-controls")).hidden = !active
    }
    updatePanes()
}

for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectPane(tab))
    tab.addEventListener("keydown", event => {
        const offset = {ArrowLeft: -1, ArrowRight: 1}[event.key]
        const next = offset ? (index + tabs.length + offset) % tabs.length :
            event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined
        if (next == null) return
        event.preventDefault()
        selectPane(tabs[next])
        tabs[next].focus()
    })
}

function message(text, failed = false) {
    element("notice").textContent = text
    element("notice").toggleAttribute("data-error", failed)
}

function selected() {
    return devices.find(device => device.id === deviceId)
}

function enabled() {
    const connection = selected()?.connection
    return unlocked && connection?.online && connection.accessGranted
}

function permissionPending(kind) {
    return snapshot[kind]?.phase === "requesting" || [...pendingJobs.values()].some(job => job.kind === kind)
}

function devicePath(suffix = "") {
    return "/devices/" + encodeURIComponent(deviceId) + suffix
}

async function call(path, {method = "GET", body, headers = {}, raw = false, signal} = {}) {
    const response = await fetch("/api/v1" + path, {
        method, signal,
        headers: body === undefined ? headers : {"Content-Type": "application/json", ...headers},
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) {
        const problem = await response.json().catch(() => ({}))
        const error = new Error(errors[problem.code] ?? problem.code ?? "HTTP " + response.status)
        error.status = response.status
        error.code = problem.code
        throw error
    }
    if (raw) return response
    return response.status === 204 ? undefined : response.json()
}

function perform(work) {
    return async event => {
        event?.preventDefault()
        try { await work(event) }
        catch (error) {
            if (error.name === "AbortError") return
            if (error.status === 401 && unlocked) {
                try { await updateSession() }
                catch (sessionError) { message(sessionError.message, true) }
            }
            message(error.message, true)
        }
    }
}

async function updateSession() {
    const status = await call("/auth/status")
    unlocked = status.unlocked
    element("auth").hidden = unlocked
    element("workspace").hidden = !unlocked
    element("lock").hidden = !unlocked
    element("setup").hidden = status.initialized
    element("unlock").hidden = !status.initialized
    if (!unlocked) {
        closeSocket()
        deviceId = undefined
        resetDeviceView()
        renderDevice()
        return
    }
    await refreshDevices()
}

function webAuthn() {
    if (!globalThis.PublicKeyCredential?.parseCreationOptionsFromJSON ||
        !globalThis.PublicKeyCredential?.parseRequestOptionsFromJSON) {
        throw new Error("请在支持 Passkey 的新版 Safari 或 Chrome 中打开此页。")
    }
}

element("setup").addEventListener("submit", perform(async () => {
    webAuthn()
    const secret = element("secret").value.trim()
    const {challengeId, publicKey} = await call("/auth/passkeys/registration/options", {method:"POST", body:{secret}})
    const credential = await navigator.credentials.create({publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey)})
    await call("/auth/passkeys/registration", {method:"POST", body:{challengeId, secret, credential:credential.toJSON()}})
    element("secret").value = ""
    await updateSession()
    message("Passkey 已注册。请解锁后台。")
}))

async function authenticate() {
    webAuthn()
    const {challengeId, publicKey} = await call("/auth/passkeys/authentication/options", {method:"POST"})
    const credential = await navigator.credentials.get({publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey)})
    await call("/auth/passkeys/authentication", {method:"POST", body:{challengeId, credential:credential.toJSON()}})
    await updateSession()
}

element("unlock").addEventListener("click", perform(async () => {
    await authenticate()
    message("后台已解锁。")
}))

element("lock").addEventListener("click", perform(async () => {
    await call("/auth/lock", {method:"POST"})
    await updateSession()
    message("后台已锁定。")
}))

async function refreshDevices() {
    if (!unlocked || refreshInProgress) return
    refreshInProgress = true
    try {
        const response = await call("/devices?limit=100")
        if (!unlocked) return
        const previous = deviceId
        const previousConnection = selected()?.connection.connectionId
        devices = response.items
        if (!selected()) deviceId = devices.find(device => device.connection.online)?.id ?? devices[0]?.id
        const select = element("devices")
        const options = devices.map(device => [device.id, device.name + (device.connection.online ? " · 在线" : " · 离线")])
        if (select.options.length !== options.length || options.some(([id, label], index) =>
            select.options[index].value !== id || select.options[index].text !== label)) {
            select.replaceChildren(...options.map(([id, label]) => new Option(label, id)))
        }
        select.disabled = !devices.length
        if (deviceId) select.value = deviceId
        if (previousConnection !== selected()?.connection.connectionId) resetFiles()
        renderDevice()
        if (previous !== deviceId) await selectDevice()
        else if (deviceId && !socket && selected()?.connection.online) connectSocket(deviceId)
    } finally {
        refreshInProgress = false
    }
}

function renderDevice() {
    const connection = selected()?.connection
    const allowed = enabled()
    if (!allowed && directory) resetFiles()
    element("access").disabled = !connection?.online || connection.accessGranted
    element("access").textContent = connection?.accessGranted ? "当前连接已授权" : "授权当前连接"
    element("revoke-access").hidden = !allowed
    element("refresh").disabled = !deviceId
    element("browse-button").disabled = !allowed
    element("parent").disabled = !allowed || !element("path").value
    element("show-hidden").disabled = !allowed
    element("next-page").disabled = !allowed || directory?.pending === true
    status("device-status", connection?.online
        ? "在线 · " + (connection.protocol ?? "") + " · " + (connection.accessGranted ? "可远程操作" : "等待授权")
        : deviceId ? "设备离线" : "等待 FileSharingService 上线")
    const quality = [
        Number.isFinite(connection?.latencyMs) && "RTT " + connection.latencyMs.toLocaleString("zh-CN", {maximumFractionDigits: 1}) + " ms",
        connection?.online && "已连接 " + duration(connection.connectionSeconds),
        connection?.lastCommunicationAt && "最近通信 " + dateText(connection.lastCommunicationAt)
    ].filter(Boolean).join(" · ")
    status("device-link-quality", quality)
    for (const row of element("permissions").rows) {
        row.querySelector("button").disabled = !enabled() || permissionPending(row.dataset.permission)
    }
    updatePanes()
}

element("devices").addEventListener("change", perform(async event => {
    deviceId = event.target.value
    renderDevice()
    await selectDevice()
}))

async function changeAccess(grant) {
    const device = selected()
    if (!device?.connection.connectionId) return
    const result = await call(devicePath("/connection-access"), {method:"PUT",
        body:{connectionId:device.connection.connectionId, enabled:grant}})
    const updated = devices.find(current => current.id === device.id && current.connection.connectionId === result.connectionId)
    if (updated) updated.connection = result
    renderDevice()
    message(grant ? "当前连接已授权。" : "已撤销当前连接的操作授权。")
}

element("access").addEventListener("click", perform(() => changeAccess(true)))
element("revoke-access").addEventListener("click", perform(() => changeAccess(false)))

element("refresh").addEventListener("click", perform(async () => {
    await refreshDevices()
    await readSnapshot()
    await data.refresh()
}))

function resetDeviceView() {
    snapshot = {}
    pendingJobs = new Map()
    resetFiles()
    renderPermissions()
}

function resetFiles(keepHeaders = false) {
    directory?.controller.abort()
    directory = undefined
    thumbnailObserver.disconnect()
    thumbnailQueue.length = 0
    for (const image of activeThumbnails) image.removeAttribute("src")
    element("entries").replaceChildren()
    element("files").hidden = !keepHeaders
    element("files").removeAttribute("aria-busy")
    element("next-page").hidden = true
    element("preview").hidden = true
    element("preview-content").textContent = ""
    element("file-status").textContent = ""
}

async function selectDevice() {
    closeSocket()
    resetDeviceView()
    if (!deviceId) return
    if (selected()?.connection.online) connectSocket(deviceId)
    await readSnapshot()
}

function closeSocket() {
    const previous = socket
    socket = undefined
    previous?.close()
    element("feed-status").textContent = "等待设备"
}

function connectSocket(id) {
    const channel = eventSocket()
    socket = channel
    element("feed-status").textContent = "WebSocket 连接中"
    channel.addEventListener("open", () => {
        if (socket !== channel) return
        for (const topic of ["permissions", "jobs.changed", "jobs.output", "connection.changed", "connection.quality"]) {
            channel.send(JSON.stringify({type:"subscribe", id:topic, deviceId:id, topic}))
        }
    })
    channel.addEventListener("message", event => {
        if (socket !== channel || id !== deviceId) return
        const frame = JSON.parse(event.data)
        if (frame.type === "subscribed" && frame.id === "permissions") {
            element("feed-status").textContent = "WebSocket 已订阅"
        }
        if (frame.type !== "event") return
        if (frame.item.topic === "permissions") {
            snapshot = frame.item.payload
            renderPermissions()
            element("feed-status").textContent = "已通过 WebSocket 收到权限状态"
        }
        if (frame.item.topic === "jobs.changed" && pendingJobs.has(frame.item.payload.id)) {
            void perform(() => readJob(frame.item.payload.id))()
        }
        if (frame.item.topic === "jobs.changed" || frame.item.topic === "jobs.output") jobs.receive(frame.item)
        if (frame.item.topic === "connection.changed") {
            void perform(refreshDevices)()
        }
        if (frame.item.topic === "connection.quality") {
            const device = selected()
            const quality = frame.item.payload
            if (device?.connection.connectionId === quality.connectionId && device?.connection.online) {
                const {latencyMs, connectionSeconds, lastCommunicationAt} = quality
                Object.assign(device.connection, {latencyMs, connectionSeconds, lastCommunicationAt})
                renderDevice()
            }
        }
    })
    channel.addEventListener("close", () => {
        if (socket !== channel) return
        socket = undefined
        element("feed-status").textContent = "WebSocket 断开 · REST 回退"
    })
}

async function readSnapshot() {
    if (!deviceId) return
    const id = deviceId
    try {
        const sample = await call(devicePath("/permissions"))
        if (id === deviceId) {
            snapshot = sample.value
            renderPermissions()
        }
    } catch (error) {
        if (error.status !== 404) throw error
    }
}

function cell(text) {
    const td = document.createElement("td")
    td.textContent = text
    return td
}

function label(value) {
    if (!value) return "待同步"
    return value.phase === "requesting" ? "等待 macOS 确认" : statuses[value.state] ?? value.state
}

function renderPermissions() {
    const rows = permissions.map(([key, name]) => {
        const value = snapshot[key]
        const row = document.createElement("tr")
        row.dataset.permission = key
        const action = cell("")
        const ask = document.createElement("button")
        ask.textContent = value?.checkedAt ? "重新检测" : "申请"
        ask.disabled = !enabled() || permissionPending(key)
        ask.addEventListener("click", perform(() => askPermission(key, name)))
        action.append(ask)
        row.append(cell(name), cell(label(value)), cell(value?.checkedAt
            ? new Date(value.checkedAt).toLocaleTimeString() : "—"), action)
        return row
    })
    element("permissions").replaceChildren(...rows)
}

async function askPermission(kind, name) {
    message("正在向 Mac 发送" + name + "申请。")
    const jobs = pendingJobs
    const job = await call(devicePath("/permissions/requests"), {method:"POST", body:{kind}})
    if (jobs !== pendingJobs) return
    pendingJobs.set(job.id, {kind, name})
    renderDevice()
    await readJob(job.id)
}

async function readJob(id) {
    const job = await call("/jobs/" + id)
    if (job.state === "queued") return
    const pending = pendingJobs.get(id)
    if (!pending) return
    pendingJobs.delete(id)
    renderDevice()
    if (job.state !== "completed") {
        message(pending.name + " · " + (errors[job.error] ?? job.error ?? job.state), true)
        return
    }

    const result = job.result?.result
    if (pending.kind === "pasteboard" && result?.state === "requiresSystemSettings") {
        message("剪贴板 · macOS 设置为每次询问。可在这台 Mac 的「隐私与安全性 → 剪贴板」修改。")
    } else if (pending.kind === "pasteboard" && result?.state === "notDetermined") {
        message("剪贴板 · macOS 尚未报告授权。可先复制一段测试文字，再重新申请。")
    } else {
        message(pending.name + " · " + label(result))
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) await readSnapshot()
}

async function pollJobs() {
    if (jobPollInProgress || pendingJobs.size === 0) return
    jobPollInProgress = true
    try {
        for (const id of pendingJobs.keys()) await readJob(id)
    } finally {
        jobPollInProgress = false
    }
}

async function browse(append = false) {
    if (!enabled()) throw new Error("请先授权当前设备连接。")
    if (!append) {
        resetFiles(!element("files").hidden)
        const path = element("path").value.replace(/^\/+|\/+$/g, "")
        directory = {
            query:new URLSearchParams({
                path, limit:"80", sort:sortKey, direction:sortDirection, hidden:element("show-hidden").checked
            }),
            controller:new AbortController()
        }
        element("file-status").textContent = "正在读取目录…"
    }

    const view = directory
    if (!view || view.pending || (append && view.page?.nextOffset == null)) return
    view.pending = true
    const {signal} = view.controller
    element("files").setAttribute("aria-busy", "true")
    renderDevice()
    try {
        if (!view.root) {
            const scopes = await call(devicePath("/file-roots"), {signal})
            view.root = scopes.items.find(scope => scope.enabled)
            if (!view.root) throw new Error("设备的 HOME 目录授权正在同步。")
        }
        if (signal.aborted) return
        const parameters = new URLSearchParams(view.query)
        parameters.set("rootId", view.root.id)
        if (append) {
            parameters.set("offset", view.page.nextOffset)
            parameters.set("revision", view.page.revision)
        }
        const result = await call(devicePath("/files/entries?") + parameters, {signal})
        if (signal.aborted) return
        view.page = result
        const rows = result.items.map(entry => entryRow(view.root, entry))
        const body = element("entries")
        body.append(...rows)
        element("files").hidden = result.total === 0
        element("next-page").hidden = result.nextOffset === null
        element("file-status").textContent = (parameters.get("path") || "HOME") + " · " + body.rows.length + " / " + result.total + " 项"
        for (const row of rows) {
            const tile = row.querySelector("[data-thumbnail-url]")
            if (tile) thumbnailObserver.observe(tile)
        }
    } catch (error) {
        if (signal.aborted) return
        if (append && error.code === "snapshot_changed") {
            await browse()
            return
        }
        if (!append) element("file-status").textContent = (view.query.get("path") || "HOME") + " · 读取失败"
        throw error
    } finally {
        if (directory === view) {
            view.pending = false
            element("files").removeAttribute("aria-busy")
            renderDevice()
        }
    }
}

function loadThumbnails() {
    while (activeThumbnails.size < 3 && thumbnailQueue.length) {
        const tile = thumbnailQueue.shift()
        if (!tile.isConnected || !enabled()) continue
        const image = new Image(44, 44)
        image.alt = ""
        image.decoding = "async"
        activeThumbnails.add(image)
        image.src = tile.dataset.thumbnailUrl
        void image.decode().then(() => {
            if (tile.isConnected) tile.replaceChildren(image)
        }, () => {
            tile.title = "缩略图不可用"
        }).finally(() => {
            activeThumbnails.delete(image)
            loadThumbnails()
        })
    }
}

function thumbnailCell(root, entry) {
    const container = cell("")
    const tile = document.createElement("span")
    tile.className = "thumbnail"
    tile.textContent = "—"
    if (entry.thumbnail && entry.version) {
        const query = new URLSearchParams({rootId:root.id, path:entry.path, version:entry.version})
        tile.dataset.thumbnailUrl = "/api/v1" + devicePath("/files/thumbnail?") + query
        tile.title = entry.thumbnail === "image" || entry.thumbnail === "pdf" ? "文件缩略图" : "macOS 文件类型图标"
    } else {
        tile.title = "设备未提供缩略图"
    }
    container.append(tile)
    return container
}

function timeCell(value) {
    const date = new Date(value ?? NaN)
    const container = cell("")
    if (!Number.isFinite(date.getTime())) {
        container.textContent = "—"
        container.title = "设备未提供此时间"
        return container
    }
    const time = document.createElement("time")
    time.dateTime = value
    time.title = value
    time.textContent = fileTimeFormat.format(date)
    container.append(time)
    return container
}

function fileSize(entry) {
    if (entry.kind !== "file") return "—"
    const unit = Math.min(byteUnits.length - 1, Math.floor(Math.log2(Math.max(1, entry.size)) / 10))
    return byteFormat.format(entry.size / 1024 ** unit) + " " + byteUnits[unit]
}

function entryRow(root, entry) {
    const row = document.createElement("tr")
    const name = cell("")
    const label = document.createElement("span")
    label.className = "file-name"
    label.textContent = entry.name
    label.title = entry.fullPath ?? entry.path
    name.append(label)
    if (entry.extension) {
        const extension = document.createElement("span")
        extension.className = "file-extension"
        extension.textContent = "." + entry.extension
        name.append(extension)
    }
    const size = cell(fileSize(entry))
    size.className = "file-size"
    if (entry.kind === "file") size.title = entry.size.toLocaleString("zh-CN") + " B"
    const action = cell("")
    if (entry.kind === "directory") {
        fileButton(action, "打开", async () => {
            element("path").value = entry.path
            await browse()
        })
    }
    if (entry.kind === "file") {
        fileButton(action, "预览", () => readFile(root, entry, true))
        fileButton(action, "下载", () => readFile(root, entry, false))
    }
    const type = cell(entry.kind === "directory" ? "文件夹" : entry.fileType ?? entry.kind)
    row.append(thumbnailCell(root, entry), name, type, size, timeCell(entry.createdAt),
        timeCell(entry.modifiedAt), timeCell(entry.lastOpenedAt), action)
    return row
}

function fileButton(parent, title, work) {
    const button = document.createElement("button")
    button.textContent = title
    button.addEventListener("click", perform(work))
    parent.append(button)
}

async function readFile(root, entry, preview) {
    if (!enabled() || !directory) return
    const {signal} = directory.controller
    const transfer = await call("/transfers", {method:"POST", headers:{"Idempotency-Key":crypto.randomUUID()},
        body:{kind:"download", deviceId, rootId:root.id, path:entry.path, version:entry.version}, signal})
    if (signal.aborted) return
    if (!transfer.downloadUrl) throw new Error("设备暂时无法下载此文件。")
    if (!preview) {
        location.assign(transfer.downloadUrl)
        return
    }
    const response = await call(transfer.downloadUrl.slice("/api/v1".length), {
        headers:entry.size ? {Range:"bytes=0-32767"} : {}, raw:true, signal
    })
    const data = new Uint8Array(await response.arrayBuffer())
    if (signal.aborted) return
    element("preview-title").textContent = entry.name
    try {
        if (data.includes(0)) throw new Error("binary")
        const content = new TextDecoder("utf-8", {fatal:false}).decode(data)
        element("preview-content").textContent = (content || "空文件") + (entry.size > data.length ? "\n\n[已显示前 32 KiB]" : "")
    } catch {
        element("preview-content").textContent = "已读取 " + data.length + " 字节。二进制文件可通过「下载」打开。"
    }
    element("preview").hidden = false
    message("已从当前设备读取 " + data.length + " 字节。")
}

element("browse").addEventListener("submit", perform(() => browse()))
element("path").addEventListener("input", () => { resetFiles(); renderDevice() })
element("next-page").addEventListener("click", perform(() => browse(true)))
element("show-hidden").addEventListener("change", perform(() => browse()))
for (const button of sortButtons) {
    button.addEventListener("click", perform(async () => {
        const key = button.dataset.sort
        sortDirection = key === sortKey && sortDirection === "asc" ? "desc" : "asc"
        sortKey = key
        for (const header of sortButtons) {
            const active = header.dataset.sort === sortKey
            if (active) header.parentElement.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending")
            else header.parentElement.removeAttribute("aria-sort")
            header.lastElementChild.textContent = active ? (sortDirection === "asc" ? "↑" : "↓") : ""
        }
        await browse()
    }))
}
element("parent").addEventListener("click", perform(async () => {
    element("path").value = element("path").value.split("/").slice(0, -1).join("/")
    await browse()
}))
for (const button of document.querySelectorAll("[data-directory]")) {
    button.addEventListener("click", perform(async () => {
        element("path").value = button.dataset.directory
        await browse()
    }))
}
setInterval(() => {
    if (!unlocked) return
    void refreshDevices().catch(error => {
        if (error.status === 401) void perform(updateSession)()
        else message(error.message, true)
    })
    void perform(pollJobs)()
    void perform(jobs.tick)()
    void perform(data.tick)()
    void perform(gateway.tick)()
}, 2500)

void perform(updateSession)()
