import {element, status} from "./ui.js"
import {terminalInput, terminalScreen} from "./terminal-pty.js"

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
    let screen

    function render() {
        openButton.disabled = !device || Boolean(opening || session)
        closeButton.disabled = !session
        command.disabled = !session || Boolean(session.running)
        runButton.disabled = !session || Boolean(session.submitting || session.running)
        interrupt.disabled = !session?.running
        const label = session?.prompt ?? (session ? "%" : "命令")
        if (prompt.textContent !== label) prompt.textContent = label
        if (screen) screen.terminal.options.disableStdin = !session?.nativeCommand
    }

    function append(text) {
        screen.terminal.writeln(text.replace(/[\x00-\x1f\x7f-\x9f]/g, "�"))
    }

    function sizeChanged(rows, columns) {
        if (!session?.interactive || session.size === rows + "x" + columns) return
        session.size = rows + "x" + columns
        session.input.addSize(rows, columns)
    }

    async function sendInput(current, packet) {
        const socket = current.socket
        if (socket?.readyState === WebSocket.OPEN) {
            const ack = await new Promise(resolve => {
                const finish = value => {
                    clearTimeout(timer)
                    current.reply = undefined
                    resolve(value)
                }
                const timer = setTimeout(() => finish(null), 7500)
                current.reply = {id: packet.id, finish}
                try { socket.send(JSON.stringify(packet)) }
                catch { finish(null) }
            })
            if (ack) {
                if (ack.code) throw Object.assign(new Error(errorText(ack.code)), {code: ack.code})
                return
            }
            socket.close()
        }
        const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(8000)])
        await call(current.path + "/input", {method: "POST", body: packet, signal})
    }

    function detach(current) {
        if (session !== current) return
        session = undefined
        current.input.close()
        current.abort.abort()
        current.reply?.finish(null)
        current.socket?.close()
        clearTimeout(current.timer)
        render()
    }

    function apply(current, page) {
        if (session !== current || page.cursor <= current.cursor) return
        if (page.truncated && page.items[0]?.index > current.cursor + 1) {
            screen.terminal.reset()
            append("[较早的终端输出已过期]")
        }
        let restoreFocus = false
        for (const item of page.items) {
            if (item.index <= current.cursor) continue
            switch (item.kind) {
                case "ready":
                    current.prompt = item.prompt
                    break
                case "command":
                    current.running = item.commandId
                    current.prompt = item.prompt
                    append((item.prompt ?? "%") + " " + item.line)
                    break
                case "started":
                    current.nativeCommand = item.commandId
                    if (output.getClientRects().length) screen.terminal.focus()
                    break
                case "output": {
                    const bytes = Uint8Array.from(atob(item.data), value => value.charCodeAt(0))
                    screen.terminal.write(bytes)
                    break
                }
                case "exit":
                    append("[" + (item.code ? errorText(item.code) + " · " : "") + "退出码 " + item.exitCode + "]")
                    current.prompt = item.prompt
                    current.running = undefined
                    current.nativeCommand = undefined
                    restoreFocus ||= document.activeElement === screen.terminal.textarea
                    break
                case "closed":
                    status("terminal-status", errorText(item.code), item.code !== "terminal_closed")
                    detach(current)
                    break
            }
        }
        current.cursor = page.cursor
        render()
        if (restoreFocus && !command.disabled) command.focus()
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
        socket.addEventListener("message", event => {
            const frame = JSON.parse(event.data)
            if (frame.type === "input") {
                if (current.reply?.id === frame.id) current.reply.finish(frame)
            } else {
                apply(current, frame)
            }
        })
        socket.addEventListener("close", () => {
            clearTimeout(current.timer)
            current.reply?.finish(null)
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
            const current = {path: base + "/" + view.id, cursor: 0, abort: new AbortController(), interactive: view.interactive}
            if (device !== target) {
                await call(current.path, {method: "DELETE"}).catch(() => {})
                return
            }
            current.input = terminalInput(packet => sendInput(current, packet), text => {
                if (session === current) status("terminal-status", text, true)
            })
            session = current
            screen ??= terminalScreen(output, {
                keys: data => {
                    if (session?.nativeCommand) session.input.addKeys(session.nativeCommand, data)
                },
                resize: sizeChanged
            })
            screen.terminal.reset()
            command.value = ""
            render()
            command.focus()
            stream(current)
            screen.measure()
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
            screen?.terminal.reset()
            command.value = ""
            status("terminal-status", device ? "" : "请先授权当前设备连接。")
            render()
        }
    }
}
