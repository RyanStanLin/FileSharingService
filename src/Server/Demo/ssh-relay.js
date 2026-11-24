import {dateText, element, status} from "./ui.js"

export function sshRelay({call, perform}) {
    const fields = element("ssh-relay-fields")
    const username = element("ssh-relay-user")
    const publicKey = element("ssh-relay-key")
    const command = element("ssh-relay-command")
    const connection = element("ssh-relay-connection")
    const fingerprint = element("ssh-relay-fingerprint")
    let target
    let pending = false
    let active

    function render() {
        fields.disabled = !target || pending || Boolean(active)
        connection.hidden = !active
    }

    function address(host, port) {
        return (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host) + ":" + port
    }

    function shellWord(value) {
        return /^[a-z0-9_.@:\[\]-]+$/i.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'"
    }

    async function close(path) {
        try { await call(path, {method: "DELETE"}) }
        catch (error) { if (error.status !== 404) throw error }
    }

    element("ssh-relay-form").addEventListener("submit", perform(async () => {
        if (!target || pending || active) return
        const device = target
        const user = username.value
        const base = "/devices/" + device.id + "/ssh-relays"
        pending = true
        render()
        try {
            const grant = await call(base, {method: "POST", body: {publicKey: publicKey.value}})
            const path = base + "/" + grant.id
            if (target !== device) {
                await close(path)
                return
            }
            active = path
            const jump = grant.jumpUser + "@" + address(grant.host, grant.port)
            command.textContent = ["ssh", "-o", "ServerAliveInterval=30", "-J", shellWord(jump), "-l",
                shellWord(user), shellWord(grant.destination)].join(" ")
            fingerprint.textContent = grant.hostKeyFingerprint
            status("ssh-relay-status", "请在 " + dateText(grant.expiresAt) + " 前于系统终端执行命令。")
        } catch (error) {
            if (target === device) status("ssh-relay-status", error.message, true)
            throw error
        } finally {
            pending = false
            render()
        }
    }))

    element("ssh-relay-copy").addEventListener("click", perform(async () => {
        await navigator.clipboard.writeText(command.textContent)
        status("ssh-relay-status", "已复制 SSH 命令。")
    }))

    element("ssh-relay-close").addEventListener("click", perform(async () => {
        const path = active
        if (!path) return
        await close(path)
        if (active !== path) return
        reset()
        status("ssh-relay-status", "SSH 中继已结束。")
    }))

    function reset() {
        active = undefined
        command.textContent = ""
        fingerprint.textContent = ""
        render()
    }

    return {
        bind(device) {
            const link = device?.connection
            const allowed = link?.online && link.accessGranted
            const next = allowed ? {id: device.id, connection: link.connectionId} : undefined
            if (next?.id === target?.id && next?.connection === target?.connection) return
            const previous = active
            target = next
            reset()
            status("ssh-relay-status", "")
            if (previous) close(previous).catch(() => {})
        }
    }
}
