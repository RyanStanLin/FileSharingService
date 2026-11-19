const element = id => document.getElementById(id)
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
    permission_denied: "macOS 拒绝访问，请先申请相应目录权限。",
    root_access_denied: "当前连接没有此目录授权。",
    not_found: "当前目录或文件不存在。",
    snapshot_unavailable: "设备状态正在同步。",
    limit_reached: "刚发出过同项申请，请稍后重试。" }

let unlocked = false
let devices = []
let deviceId
let snapshot = {}
let socket
let pendingJobs = new Map()
let page
let refreshInProgress = false
let jobPollInProgress = false

function message(text, failed = false) {
    element("notice").textContent = text
    element("notice").toggleAttribute("data-error", failed)
}

function selected() {
    return devices.find(device => device.id === deviceId)
}

function enabled() {
    return selected()?.connection.online && selected()?.connection.accessGranted
}

function permissionPending(kind) {
    return snapshot[kind]?.phase === "requesting" || [...pendingJobs.values()].some(job => job.kind === kind)
}

function devicePath(suffix = "") {
    return "/devices/" + encodeURIComponent(deviceId) + suffix
}

async function call(path, {method = "GET", body, headers = {}, raw = false} = {}) {
    const response = await fetch("/api/v1" + path, {
        method,
        headers: body === undefined ? headers : {"Content-Type": "application/json", ...headers},
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) {
        const problem = await response.json().catch(() => ({}))
        const error = new Error(errors[problem.code] ?? problem.code ?? "HTTP " + response.status)
        error.status = response.status
        throw error
    }
    if (raw) return response
    return response.status === 204 ? undefined : response.json()
}

function perform(work) {
    return async event => {
        event?.preventDefault()
        try { await work(event) }
        catch (error) { message(error.message, true) }
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

element("unlock").addEventListener("click", perform(async () => {
    webAuthn()
    const {challengeId, publicKey} = await call("/auth/passkeys/authentication/options", {method:"POST"})
    const credential = await navigator.credentials.get({publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey)})
    await call("/auth/passkeys/authentication", {method:"POST", body:{challengeId, credential:credential.toJSON()}})
    await updateSession()
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
        devices = (await call("/devices?limit=100")).items
        const previous = deviceId
        if (!selected()?.connection.online) deviceId = devices.find(device => device.connection.online)?.id ?? deviceId
        if (!selected()) deviceId = devices[0]?.id
        const select = element("devices")
        select.replaceChildren(...devices.map(device =>
            new Option(device.name + (device.connection.online ? " · 在线" : " · 离线"), device.id)))
        select.disabled = !devices.length
        if (deviceId) select.value = deviceId
        renderDevice()
        if (previous !== deviceId) await selectDevice()
        else if (deviceId && !socket && selected()?.connection.online) connectSocket(deviceId)
    } finally {
        refreshInProgress = false
    }
}

function renderDevice() {
    const connection = selected()?.connection
    element("access").disabled = !connection?.online || connection.accessGranted
    element("access").textContent = connection?.accessGranted ? "当前连接已授权" : "授权当前连接"
    element("refresh").disabled = !deviceId
    element("browse-button").disabled = !enabled()
    element("parent").disabled = !enabled() || !element("path").value
    element("device-status").textContent = connection?.online
        ? "在线 · " + (connection.protocol ?? "") + " · " + (connection.accessGranted ? "可远程操作" : "等待授权")
        : deviceId ? "设备离线" : "等待 FileSharingService 上线"
    for (const row of element("permissions").rows) {
        row.querySelector("button").disabled = !enabled() || permissionPending(row.dataset.permission)
    }
}

element("devices").addEventListener("change", perform(async event => {
    deviceId = event.target.value
    renderDevice()
    await selectDevice()
}))

element("access").addEventListener("click", perform(async () => {
    const device = selected()
    if (!device?.connection.connectionId) return
    const result = await call(devicePath("/connection-access"), {method:"PUT",
        body:{connectionId:device.connection.connectionId, enabled:true}})
    device.connection = result
    renderDevice()
    message("当前连接已授权。可以申请权限或读取目录。")
}))

element("refresh").addEventListener("click", perform(async () => {
    await refreshDevices()
    await readSnapshot()
}))

function resetDeviceView() {
    snapshot = {}
    pendingJobs = new Map()
    page = undefined
    element("files").hidden = true
    element("next-page").hidden = true
    element("preview").hidden = true
    element("preview-content").textContent = ""
    element("file-status").textContent = ""
    renderPermissions()
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
    const url = new URL("/api/v1/events/ws", location.href)
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const channel = new WebSocket(url)
    socket = channel
    element("feed-status").textContent = "WebSocket 连接中"
    channel.addEventListener("open", () => {
        if (socket !== channel) return
        for (const topic of ["permissions", "jobs.changed", "connection.changed"]) {
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
        if (frame.item.topic === "connection.changed") {
            void perform(refreshDevices)()
        }
    })
    channel.addEventListener("close", () => {
        if (socket !== channel) return
        socket = undefined
        element("feed-status").textContent = "WebSocket 断开，可刷新状态"
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

async function browse({append = false} = {}) {
    if (!enabled()) throw new Error("请先授权当前设备连接。")
    const id = deviceId
    const path = element("path").value.replace(/^\/+|\/+$/g, "")
    const scopes = await call(devicePath("/file-roots"))
    const root = scopes.items.find(scope => scope.enabled)
    if (!root) throw new Error("设备的 HOME 目录授权正在同步。")
    const parameters = new URLSearchParams({rootId:root.id, path, limit:"80"})
    if (append && page?.nextOffset !== null) {
        parameters.set("offset", page.nextOffset)
        parameters.set("revision", page.revision)
    }
    const result = await call(devicePath("/files/entries?") + parameters)
    if (id !== deviceId) return
    page = result
    const rows = result.items.map(entry => entryRow(root, entry))
    if (!append) {
        element("entries").replaceChildren()
        element("preview").hidden = true
        element("preview-content").textContent = ""
    }
    element("entries").append(...rows)
    element("files").hidden = result.total === 0
    element("next-page").hidden = result.nextOffset === null
    element("file-status").textContent = (path || "HOME") + " · " + result.total + " 个项目"
    renderDevice()
}

function entryRow(root, entry) {
    const row = document.createElement("tr")
    const name = cell(entry.name)
    const size = cell(entry.kind === "file" ? entry.size.toLocaleString() + " B" : "—")
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
    row.append(name, size, action)
    return row
}

function fileButton(parent, title, work) {
    const button = document.createElement("button")
    button.textContent = title
    button.addEventListener("click", perform(work))
    parent.append(button)
}

async function readFile(root, entry, preview) {
    const id = deviceId
    const transfer = await call("/transfers", {method:"POST", headers:{"Idempotency-Key":crypto.randomUUID()},
        body:{kind:"download", deviceId:id, rootId:root.id, path:entry.path, version:entry.version}})
    if (!transfer.downloadUrl) throw new Error("设备暂时无法下载此文件。")
    if (!preview) {
        location.assign(transfer.downloadUrl)
        return
    }
    const response = await call(transfer.downloadUrl.slice("/api/v1".length), {
        headers:entry.size ? {Range:"bytes=0-32767"} : {}, raw:true
    })
    const data = new Uint8Array(await response.arrayBuffer())
    if (id !== deviceId) return
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
element("path").addEventListener("input", () => { element("next-page").hidden = true; renderDevice() })
element("next-page").addEventListener("click", perform(() => browse({append:true})))
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
}, 2500)

void perform(updateSession)()
