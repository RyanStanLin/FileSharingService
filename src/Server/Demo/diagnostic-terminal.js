import {dateText, element, status} from "./ui.js"
import {terminalInput, terminalScreen} from "./terminal-pty.js"

export function diagnosticTerminal({call, perform, errorText}) {
    const openButton = element("terminal-open")
    const terminate = element("terminal-close")
    const remove = element("terminal-delete")
    const select = element("terminal-sessions")
    const refresh = element("terminal-refresh")
    const more = element("terminal-more")
    const transcript = element("terminal-export")
    const command = element("terminal-command")
    const prompt = element("terminal-prompt")
    const runButton = element("terminal-run")
    const interrupt = element("terminal-interrupt")
    const output = element("terminal-output")
    const history = element("terminal-transcript")
    const records = new Map()
    const selected = new Map()
    let device
    let visible = false
    let cursor
    let opening
    let session
    let screen

    const base = id => "/devices/" + id + "/diagnostics/sessions"
    const closed = view => view?.state === "terminated"
    const receivingKeys = current => current?.view.canControl && current.nativeCommand &&
        current.nativeCommand === current.view.commandId

    function stateText(view) {
        switch (view.state) {
            case "starting": return "正在启动"
            case "terminating": return "等待 Mac 确认终止"
            case "terminated": return "已终止"
            default:
                if (!view.connected) return "等待重连" + (view.commandStarted ? " · 上次状态为运行中" : "")
                const activity = view.commandId ? (view.commandStarted ? "程序运行中" : "命令待执行") : "会话就绪"
                return activity + (view.canControl ? "" : " · 控制需授权当前连接")
        }
    }

    function render() {
        const view = session?.view
        const busy = Boolean(opening || [...records.values()].some(record => !closed(record)))
        openButton.disabled = !device?.allowed || busy
        terminate.disabled = !view || closed(view) || view.state === "terminating"
        remove.disabled = !closed(view)
        const allowed = view?.canControl && !view.commandId && !session.submitting
        command.disabled = !allowed
        runButton.disabled = !allowed
        interrupt.disabled = !view?.canControl || !view.commandStarted
        select.disabled = !device
        refresh.disabled = !device
        more.hidden = !cursor
        transcript.hidden = !session
        if (session) transcript.href = "/api/v1" + session.path + "/transcript"
        else transcript.removeAttribute("href")
        const label = session?.prompt ?? (session ? "%" : "命令")
        if (prompt.textContent !== label) prompt.textContent = label
        if (screen) {
            screen.terminal.options.disableStdin = !receivingKeys(session)
            const readOnly = Boolean(view && !view.canControl)
            screen.terminal.element.hidden = readOnly
            history.hidden = !readOnly
            if (readOnly && history.textContent !== session.text) {
                const follow = history.scrollHeight - history.scrollTop - history.clientHeight < 32
                history.textContent = session.text
                if (follow) history.scrollTop = history.scrollHeight
            } else if (!readOnly) {
                history.textContent = ""
            }
        }
        status("terminal-state", view ? stateText(view) : "")
    }

    function renderList() {
        const sorted = [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        select.replaceChildren(new Option("选择会话", ""), ...sorted.map(view =>
            new Option(dateText(view.createdAt) + " · " + stateText(view), view.id)))
        select.value = session?.view.id ?? ""
    }

    function remember(view) {
        const old = records.get(view.id)
        records.set(view.id, view)
        if (!old || stateText(old) !== stateText(view)) renderList()
    }

    function append(text) {
        screen.terminal.writeln(text.replace(/[\x00-\x1f\x7f-\x9f]/g, "�"))
    }

    function sizeChanged(rows, columns) {
        if (!session?.view.canControl || !session.view.interactive || session.size === rows + "x" + columns) return
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

    function detach() {
        const current = session
        if (!current) return
        session = undefined
        current.input.close()
        current.abort.abort()
        current.reply?.finish(null)
        current.socket?.close()
        clearTimeout(current.timer)
        screen?.terminal.reset()
        command.value = ""
        render()
    }

    function apply(current, page) {
        if (session !== current || page.cursor < current.cursor) return
        const wasAllowed = current.view.canControl
        current.view = page.session
        remember(current.view)
        let restoreFocus = false
        const text = []
        const line = value => {
            text.push(value + "\n")
            append(value)
        }
        for (const item of page.items) {
            if (item.index <= current.cursor) continue
            switch (item.kind) {
                case "ready":
                    current.prompt = item.prompt
                    break
                case "command":
                    current.prompt = item.prompt
                    line((item.prompt ?? "%") + " " + item.line)
                    break
                case "started":
                    current.nativeCommand = item.commandId
                    if (receivingKeys(current) && visible) screen.terminal.focus()
                    break
                case "output": {
                    const bytes = Uint8Array.from(atob(item.data), value => value.charCodeAt(0))
                    screen.terminal.write(bytes)
                    text.push(current.decoder.decode(bytes, {stream: true}))
                    break
                }
                case "exit":
                    line("[" + (item.code ? errorText(item.code) + " · " : "") + "退出码 " + item.exitCode + "]")
                    current.prompt = item.prompt
                    current.nativeCommand = undefined
                    restoreFocus ||= document.activeElement === screen.terminal.textarea
                    break
                case "closed":
                    current.nativeCommand = undefined
                    line("[" + errorText(item.code) + "]")
                    break
            }
        }
        const plain = text.join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, "")
        current.text = (current.text + plain).slice(-262144)
        current.cursor = page.cursor
        current.complete = page.closed
        render()
        if (!wasAllowed && current.view.canControl) {
            current.size = undefined
            screen.measure()
        }
        if (restoreFocus && !command.disabled) command.focus()
    }

    async function poll(current) {
        if (session !== current || current.complete) return
        let delay = 500
        try {
            const page = await call(current.path + "/output?after=" + current.cursor, {signal: current.abort.signal})
            apply(current, page)
            if (session !== current) return
            if (current.complete) {
                status("terminal-status", "已加载完整记录")
                return
            }
            if (current.retryStream && !page.hasMore) {
                current.retryStream = false
                stream(current)
                return
            }
            status("terminal-status", "会话已连接 · HTTP 续读")
            if (page.hasMore) delay = 0
        } catch (error) {
            if (session !== current) return
            if ([400, 401, 403, 404].includes(error.status)) {
                detach()
                status("terminal-status", error.message, true)
                return
            }
            current.retryStream = true
            status("terminal-status", "正在恢复终端连接…")
        }
        if (session === current) current.timer = setTimeout(() => poll(current), delay)
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
            if (session !== current) return
            if (current.complete) status("terminal-status", "已加载完整记录")
            else poll(current)
        })
    }

    function show(view) {
        if (!visible || view.deviceId !== device?.id || view.id === session?.view.id) return
        detach()
        const current = {path: base(view.deviceId) + "/" + view.id, view, cursor: 0, text: "",
            decoder: new TextDecoder(), abort: new AbortController()}
        current.input = terminalInput(packet => sendInput(current, packet), text => {
            if (session === current) status("terminal-status", text, true)
        })
        session = current
        selected.set(device.id, view.id)
        screen ??= terminalScreen(output, {
            keys: data => {
                if (receivingKeys(session)) session.input.addKeys(session.nativeCommand, data)
            },
            resize: sizeChanged
        })
        screen.terminal.reset()
        screen.measure()
        remember(view)
        renderList()
        render()
        if (!command.disabled) command.focus()
        if (closed(view)) poll(current)
        else stream(current)
    }

    async function list(append = false) {
        const target = device?.id
        if (!target || !visible) return
        const page = await call(base(target) + (append && cursor ? "?cursor=" + cursor : ""))
        if (device?.id !== target || !visible) return
        if (!append) records.clear()
        for (const view of page.items) records.set(view.id, view)
        if (page.active) records.set(page.active.id, page.active)
        if (session && !records.has(session.view.id)) records.set(session.view.id, session.view)
        cursor = page.nextCursor
        renderList()
        render()
        if (!session) {
            const view = records.get(selected.get(target)) ?? [...records.values()].find(item => !closed(item))
            if (view) show(view)
        }
    }

    openButton.addEventListener("click", perform(async () => {
        const target = device.id
        opening = target
        render()
        status("terminal-status", "正在打开终端…")
        try {
            const view = await call(base(target), {method: "POST", body: {}})
            if (device?.id === target) {
                remember(view)
                show(view)
            }
        } finally {
            opening = undefined
            render()
        }
    }))

    select.addEventListener("change", () => {
        const view = records.get(select.value)
        if (view) show(view)
        else {
            selected.delete(device.id)
            detach()
            status("terminal-status", "")
        }
    })
    refresh.addEventListener("click", perform(() => list()))
    more.addEventListener("click", perform(() => list(true)))

    terminate.addEventListener("click", perform(async () => {
        const current = session
        if (!current) return
        await call(current.path + "/terminate", {method: "POST"})
        if (session === current && !closed(current.view)) {
            current.view = {...current.view, state: "terminating", canControl: false}
            remember(current.view)
            render()
        }
    }))

    remove.addEventListener("click", perform(async () => {
        const current = session
        if (!closed(current?.view) || !window.confirm("删除此会话的全部记录？")) return
        await call(current.path, {method: "DELETE"})
        if (session === current) {
            records.delete(current.view.id)
            selected.delete(device.id)
            detach()
            renderList()
            status("terminal-status", "终端记录已删除。")
        }
    }))

    element("terminal-form").addEventListener("submit", perform(async () => {
        const current = session
        const line = command.value.trim()
        if (!line || !current?.view.canControl || current.submitting || current.view.commandId) return
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
        if (session?.view.commandStarted) await call(session.path + "/interrupt", {method: "POST"})
    }))

    window.addEventListener("pagehide", detach)

    return {
        bind(value, showPane) {
            const previousId = device?.id
            const previouslyVisible = visible
            visible = showPane
            device = value ? {id: value.id, allowed: value.connection?.online && value.connection.accessGranted} : undefined
            if (previousId !== device?.id || !visible) {
                detach()
                records.clear()
                cursor = undefined
                renderList()
                status("terminal-status", "")
            }
            render()
            if (visible && device && (!previouslyVisible || previousId !== device.id)) {
                list().catch(error => status("terminal-status", error.message, true))
            }
        }
    }
}
