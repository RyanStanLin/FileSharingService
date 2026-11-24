import {Terminal} from "./xterm/xterm.mjs"
import {FitAddon} from "./xterm/addon-fit.mjs"

const maxChunk = 4096
const maxQueued = 65536
const encoder = new TextEncoder()

export function terminalScreen(container, {keys, resize}) {
    const terminal = new Terminal({
        fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, cursorBlink: true,
        theme: {background: "#161b22", foreground: "#e6edf3", cursor: "#e6edf3"},
        scrollback: 1500, disableStdin: true
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.parser.registerOscHandler(52, () => true)
    terminal.onData(data => keys(encoder.encode(data)))
    terminal.onBinary(data => keys(Uint8Array.from(data, value => value.charCodeAt(0))))

    function measure() {
        if (!container.clientWidth || !container.clientHeight) return
        const size = fit.proposeDimensions()
        if (!size) return
        terminal.resize(Math.max(2, Math.min(size.cols, 300)), Math.max(2, Math.min(size.rows, 160)))
        resize(terminal.rows, terminal.cols)
    }
    new ResizeObserver(measure).observe(container)
    document.fonts.ready.then(measure)
    return {terminal, measure}
}

export function terminalInput(send, report) {
    const queue = []
    let bytes = 0
    let timer
    let sending = false
    let closed = false

    function schedule() {
        if (!timer && !sending) timer = setTimeout(drain, 12)
    }

    function addKeys(commandId, data) {
        if (closed || !data.length) return
        if (data.length + bytes > maxQueued) {
            report("终端输入过多，请分段粘贴。")
            return
        }
        bytes += data.length
        let offset = 0
        while (offset < data.length) {
            const last = queue.at(-1)
            if (last?.kind === "keys" && last.commandId === commandId && last.bytes.length < maxChunk) {
                const count = Math.min(maxChunk - last.bytes.length, data.length - offset)
                const combined = new Uint8Array(last.bytes.length + count)
                combined.set(last.bytes)
                combined.set(data.subarray(offset, offset + count), last.bytes.length)
                last.bytes = combined
                offset += count
            } else {
                queue.push({kind: "keys", commandId, bytes: data.subarray(offset, offset + maxChunk)})
                offset += maxChunk
            }
        }
        schedule()
    }

    function addSize(rows, columns) {
        if (closed) return
        const packet = {kind: "resize", rows, columns}
        if (queue.at(-1)?.kind === "resize") queue[queue.length - 1] = packet
        else queue.push(packet)
        schedule()
    }

    async function drain() {
        timer = undefined
        sending = true
        try {
            while (queue.length && !closed) {
                const {bytes: data, ...packet} = queue.shift()
                if (data) {
                    bytes -= data.length
                    packet.data = btoa(String.fromCharCode(...data))
                }
                try {
                    await send({...packet, id: crypto.randomUUID()})
                } catch (error) {
                    if (!closed && error.code !== "terminal_command_ended") report(error.message)
                }
            }
        } finally {
            sending = false
        }
    }

    return {
        addKeys, addSize,
        close() {
            closed = true
            queue.length = 0
            clearTimeout(timer)
        }
    }
}
