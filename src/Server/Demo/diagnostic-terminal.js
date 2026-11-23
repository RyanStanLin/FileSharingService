import {element, status} from "./ui.js"

export function diagnosticTerminal({call, perform, errorText}) {
    const openButton = element("terminal-open")
    const closeButton = element("terminal-close")
    const command = element("terminal-command")
    const prompt = element("terminal-prompt")
    const runButton = element("terminal-run")
    const interrupt = element("terminal-interrupt")
    const output = element("terminal-output")
    let device
    let opening
    let session

    function render() {
        openButton.disabled = !device || Boolean(opening || session)
        closeButton.disabled = !session
        command.disabled = !session
        runButton.disabled = !session || Boolean(session.submitting || session.running)
        interrupt.disabled = !session?.running
        const label = session?.prompt ?? (session ? "%" : "命令")
        if (prompt.textContent !== label) prompt.textContent = label
    }

    function append(text) {
        const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 36
        output.textContent = (output.textContent + text).slice(-131072)
        if (follow) output.scrollTop = output.scrollHeight
    }

    function detach(current) {
        if (session !== current) return
        session = undefined
        current.socket?.close()
        clearTimeout(current.timer)
        current.abort.abort()
        render()
    }

    function apply(current, page) {
        if (session !== current || page.cursor <= current.cursor) return
        if (page.truncated && page.items[0]?.index > current.cursor + 1) {
            current.decoder = new TextDecoder()
            append("\n[较早的终端输出已过期]\n")
        }
        for (const item of page.items) {
            if (item.index <= current.cursor) continue
            switch (item.kind) {
                case "ready":
                    current.prompt = item.prompt
                    break
                case "command":
                    current.running = item.commandId
                    current.prompt = item.prompt
                    append((item.prompt ?? "%") + " " + item.line + "\n")
                    break
                case "output": {
                    const bytes = Uint8Array.from(atob(item.data), value => value.charCodeAt(0))
                    append(current.decoder.decode(bytes, {stream: true}).replaceAll("\r", ""))
                    break
                }
                case "exit":
                    append(current.decoder.decode())
                    append("[" + (item.code ? errorText(item.code) + " · " : "") + "退出码 " + item.exitCode + "]\n")
                    current.prompt = item.prompt
                    current.running = undefined
                    break
                case "closed":
                    status("terminal-status", errorText(item.code), item.code !== "terminal_closed")
                    detach(current)
                    break
            }
        }
        current.cursor = page.cursor
        render()
    }

    async function poll(current) {
        if (session !== current) return
        try {
            const page = await call(current.path + "/output?after=" + current.cursor, {signal: current.abort.signal})
            apply(current, page)
            if (session === current) status("terminal-status", "会话已连接 · HTTP 续读")
        } catch (error) {
            if (session !== current) return
            if ([400, 401, 403, 404, 409, 410].includes(error.status) || error.code === "agent_connection_ended") {
                detach(current)
                status("terminal-status", error.message, true)
                return
            }
            status("terminal-status", "正在恢复终端输出…")
        }
        if (session === current) current.timer = setTimeout(() => poll(current), 500)
    }

    function stream(current) {
        const url = new URL("/api/v1" + current.path + "/ws?after=" + current.cursor, location.href)
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url)
        current.socket = socket
        current.timer = setTimeout(() => socket.close(), 3000)
        socket.addEventListener("open", () => {
            clearTimeout(current.timer)
            if (session === current) status("terminal-status", "会话已连接 · WebSocket")
        })
        socket.addEventListener("message", event => apply(current, JSON.parse(event.data)))
        socket.addEventListener("close", () => {
            clearTimeout(current.timer)
            if (session === current) poll(current)
        })
    }

    openButton.addEventListener("click", perform(async () => {
        const target = device
        opening = target
        render()
        status("terminal-status", "正在打开终端…")
        try {
            const base = "/devices/" + target.id + "/diagnostics/sessions"
            const view = await call(base, {method: "POST", body: {}})
            const current = {path: base + "/" + view.id, cursor: 0, abort: new AbortController(), decoder: new TextDecoder()}
            if (device !== target) {
                await call(current.path, {method: "DELETE"}).catch(() => {})
                return
            }
            session = current
            output.textContent = ""
            command.value = ""
            render()
            command.focus()
            stream(current)
        } catch (error) {
            if (device === target) status("terminal-status", error.message, true)
            throw error
        } finally {
            opening = undefined
            render()
        }
    }))

    closeButton.addEventListener("click", perform(async () => {
        const current = session
        await call(current.path, {method: "DELETE"})
        if (session === current) {
            detach(current)
            status("terminal-status", "终端已结束。")
        }
    }))

    element("terminal-form").addEventListener("submit", perform(async () => {
        const current = session
        const line = command.value.trim()
        if (!current || !line || current.submitting || current.running) return
        current.submitting = true
        render()
        try {
            await call(current.path + "/commands", {method: "POST", body: {line}})
            if (session === current && command.value.trim() === line) command.value = ""
        } finally {
            current.submitting = false
            render()
        }
    }))

    interrupt.addEventListener("click", perform(async () => {
        if (session?.running) await call(session.path + "/interrupt", {method: "POST"})
    }))
    command.addEventListener("keydown", event => {
        if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "c" && !interrupt.disabled) {
            event.preventDefault()
            interrupt.click()
        }
    })

    function release() {
        if (session) {
            const current = session
            detach(current)
            fetch("/api/v1" + current.path, {method: "DELETE", keepalive: true}).catch(() => {})
        }
    }
    window.addEventListener("pagehide", release)

    return {
        bind(value) {
            const connection = value?.connection
            const allowed = connection?.online && connection.accessGranted
            if (device?.id === (allowed ? value.id : undefined) && device?.connectionId === (allowed ? connection.connectionId : undefined))
                return
            release()
            device = allowed ? {id: value.id, connectionId: connection.connectionId} : undefined
            output.textContent = ""
            command.value = ""
            status("terminal-status", device ? "" : "请先授权当前设备连接。")
            render()
        }
    }
}
