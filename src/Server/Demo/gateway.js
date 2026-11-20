import {blankRow, dateText, element, node, row, status} from "./ui.js"

const protocols = {ftp: "FTP", ftps: "FTPS", sftp: "SFTP"}
const modes = {plain: ["ftp", "FTP"], explicitTls: ["ftps", "显式 FTPS"], implicitTls: ["ftps", "隐式 FTPS"], sftp: ["sftp", "SFTP"]}

export function gatewayPanel({call, perform, authenticate}) {
    let view

    function bind(visible) {
        if (visible === Boolean(view)) return
        if (!visible) {
            view.controller.abort()
            view = undefined
            clearCredential()
            element("gateway-create").reset()
            element("gateway-account-form").reset()
            element("gateway-rotate").reset()
            element("gateway-account-detail").hidden = true
            element("gateway-endpoints").replaceChildren()
            element("gateway-accounts").replaceChildren()
            element("gateway-connections").replaceChildren()
            status("gateway-status", "")
            status("gateway-connections-status", "")
            return
        }
        view = {controller: new AbortController(), rows: [], endpoints: []}
        renderControls(view)
        status("gateway-status", "正在读取监听端点和账号…")
        void perform(reload)()
    }

    async function reload() {
        const state = view
        if (!state || state.loading || state.busy) return
        state.loading = true
        const options = {signal: state.controller.signal}
        try {
            const [endpoints, accounts] = await Promise.all([call("/ftp/connection", options), call("/ftp/accounts?limit=50", options)])
            if (state !== view) return
            state.endpoints = endpoints
            state.rows = accounts.items
            state.nextCursor = accounts.nextCursor
            renderEndpoints(state)
            renderAccounts(state)
            if (state.selected) {
                const account = await call(accountPath(state.selected.id), options).catch(error => {
                    if (error.status !== 404) throw error
                })
                if (state !== view) return
                selectAccount(state, account)
            }
            await readConnections(state)
        } catch (error) {
            if (view === state && error.name !== "AbortError") status("gateway-status", error.message, true)
            if (error.status === 401) throw error
        } finally {
            state.loading = false
            if (state === view) renderControls(state)
        }
    }

    function renderEndpoints(state) {
        const select = element("gateway-mode")
        const selectedMode = select.value
        const available = new Set(state.endpoints.filter(item => item.available !== false).map(item => modes[item.mode][0]))
        const order = ["sftp", "ftps", "ftp"].filter(mode => available.has(mode))
        select.replaceChildren(...order.map(mode => new Option(protocols[mode], mode)))
        if (available.has(selectedMode)) select.value = selectedMode
        const rows = state.endpoints.map(endpoint => {
            const item = node("li")
            item.append(node("strong", modes[endpoint.mode][1]), node("code", endpoint.address))
            if (endpoint.available === false) item.append(node("span", "未就绪", "muted"))
            if (endpoint.hostKeyFingerprint) item.append(node("code", endpoint.hostKeyFingerprint, "muted"))
            return item
        })
        element("gateway-endpoints").replaceChildren(...rows)
        const hint = available.has("ftp") ? "在 Finder 的「连接服务器」中输入上方 FTP 地址，包含 ftp:// 和端口。Finder 以只读方式挂载。" :
            order.length ? "使用文件传输客户端连接对应协议和端口。" : "当前服务未启用文件网关。"
        status("gateway-status", hint)
    }

    function renderAccounts(state) {
        const items = state.rows.map(account => {
            const action = node("button", "管理")
            action.type = "button"
            action.setAttribute("aria-label", "管理 " + account.name)
            action.addEventListener("click", () => {
                if (!state.busy && !state.loading && view === state) selectAccount(state, account, true)
            })
            return row(account.name, protocols[account.mode] ?? account.mode,
                account.scope === "activeHomes" ? "已授权在线 Mac 的主目录" : "指定根目录 · " + account.rootIds.length,
                account.disabled ? "停用" : "启用", action)
        })
        element("gateway-accounts").replaceChildren(...(items.length ? items : [blankRow("暂无账号", 5)]))
        element("gateway-more").hidden = !state.nextCursor
    }

    async function loadMore() {
        const state = view
        if (!state?.nextCursor || state.loading || state.busy) return
        state.loading = true
        renderControls(state)
        try {
            const query = new URLSearchParams({limit: "50", cursor: state.nextCursor})
            const accounts = await call("/ftp/accounts?" + query, {signal: state.controller.signal})
            if (state !== view) return
            state.rows.push(...accounts.items.filter(account => !state.rows.some(row => row.id === account.id)))
            state.nextCursor = accounts.nextCursor
            renderAccounts(state)
        } finally {
            state.loading = false
            if (state === view) renderControls(state)
        }
    }

    function selectAccount(state, account, focus = false) {
        state.selected = account
        clearCredential()
        status("gateway-account-status", "")
        element("gateway-account-detail").hidden = !account
        element("gateway-new-password").value = ""
        if (!account) return
        element("gateway-account-heading").textContent = account.name + " · " + protocols[account.mode]
        element("gateway-edit-name").value = account.name
        element("gateway-enabled").checked = !account.disabled
        element("gateway-credential-label").textContent = account.passwordRetrievable
            ? "轮换会使旧连接失效。查看密码可能要求再次验证 Passkey。"
            : "可轮换密码并记录本次返回的凭据。当前账号未保存可查询的密码。"
        if (account.passwordChangedAt)
            element("gateway-credential-label").append(" 最近更新 " + dateText(account.passwordChangedAt) + "。")
        renderControls(state)
        if (focus) element("gateway-edit-name").focus()
    }

    function renderControls(state) {
        const busy = state.busy || state.loading
        element("gateway-create-fields").disabled = Boolean(busy) || element("gateway-mode").options.length === 0
        element("gateway-account-fields").disabled = Boolean(busy)
        element("gateway-rotate").querySelector('[type="submit"]').disabled = Boolean(busy)
        element("gateway-reveal").disabled = Boolean(busy) || !state.selected?.passwordRetrievable
        element("gateway-more").disabled = Boolean(busy)
        element("gateway-reload").disabled = Boolean(busy)
        element("close-account").disabled = Boolean(busy)
    }

    async function readConnections(state) {
        if (!state || state.polling) return
        state.polling = true
        try {
            const active = await call("/ftp/connections", {signal: state.controller.signal})
            if (state !== view) return
            const names = new Map(state.rows.map(account => [account.id, account.name]))
            const items = active.map(entry => row(names.get(entry.accountId) ?? entry.accountId, protocols[entry.protocol] ?? entry.protocol,
                entry.peerAddress, dateText(entry.connectedAt), dateText(entry.lastActivityAt)))
            element("gateway-connections").replaceChildren(...(items.length ? items : [blankRow("没有已登录的客户端", 5)]))
            status("gateway-connections-status", items.length + " 个在线连接")
        } finally {
            state.polling = false
        }
    }

    const accountPath = id => "/ftp/accounts/" + encodeURIComponent(id)

    function remember(state, account) {
        const index = state.rows.findIndex(item => item.id === account.id)
        if (index === -1) state.rows.unshift(account)
        else state.rows[index] = account
        renderAccounts(state)
        selectAccount(state, account)
    }

    function clearCredential() {
        element("gateway-visible-password").value = ""
        element("gateway-credential").hidden = true
    }

    function displayCredential(password) {
        element("gateway-visible-password").value = password
        element("gateway-credential").hidden = false
    }

    function submit(statusId, work) {
        return perform(async () => {
            const state = view
            if (!state || state.loading || state.busy) return
            state.busy = true
            renderControls(state)
            status(statusId, "正在保存…")
            try {
                await work(state, state.controller.signal)
            } catch (error) {
                if (view === state && error.name !== "AbortError")
                    status(statusId, error.status === 409 && error.code === "revision_conflict"
                        ? "账号已被更新。请刷新网关，再提交。" : error.message, true)
                if (error.status === 401) throw error
            } finally {
                state.busy = false
                if (view === state) renderControls(state)
            }
        })
    }

    element("gateway-reload").addEventListener("click", perform(reload))
    element("gateway-more").addEventListener("click", perform(loadMore))
    element("gateway-create").addEventListener("submit", submit("gateway-status", async (state, signal) => {
        const created = await call("/ftp/accounts", {method: "POST", signal, body: {
            name: element("gateway-name").value.trim(), mode: element("gateway-mode").value, scope: "activeHomes",
            password: element("gateway-password").value || null
        }})
        if (view !== state) return
        element("gateway-name").value = ""
        element("gateway-password").value = ""
        remember(state, created.account)
        displayCredential(created.password)
        status("gateway-status", "账号已创建。")
        status("gateway-account-status", "已签发密码。")
        element("gateway-visible-password").focus()
    }))
    element("close-account").addEventListener("click", () => {
        if (!view) return
        const id = view.selected?.id
        const index = view.rows.findIndex(row => row.id === id)
        selectAccount(view, undefined)
        element("gateway-accounts").rows[index]?.querySelector("button")?.focus()
    })
    element("gateway-account-form").addEventListener("submit", submit("gateway-account-status", async (state, signal) => {
        const account = state.selected
        if (!account) return
        const updated = await call(accountPath(account.id), {method: "PUT", signal, body: {
            name: element("gateway-edit-name").value.trim(), disabled: !element("gateway-enabled").checked,
            revision: account.revision, scope: account.scope, rootIds: account.rootIds
        }})
        if (view !== state) return
        remember(state, updated)
        status("gateway-account-status", "账号已保存。")
        await readConnections(state)
    }))
    element("gateway-rotate").addEventListener("submit", submit("gateway-account-status", async (state, signal) => {
        const account = state.selected
        if (!account) return
        const rotated = await call(accountPath(account.id) + "/password", {method: "PUT", signal, body: {
            revision: account.revision, password: element("gateway-new-password").value || null
        }})
        if (view !== state) return
        remember(state, rotated.account)
        displayCredential(rotated.password)
        status("gateway-account-status", "密码已轮换。旧连接已失效。")
        element("gateway-visible-password").focus()
        await readConnections(state)
    }))
    element("gateway-reveal").addEventListener("click", submit("gateway-account-status", async (state, signal) => {
        const reveal = () => call(accountPath(state.selected.id) + "/password/reveal", {method: "POST", signal})
        status("gateway-account-status", "正在读取已保存的密码…")
        let result
        try {
            result = await reveal()
        } catch (error) {
            if (error.code !== "fresh_passkey_required" || view !== state) throw error
            status("gateway-account-status", "请验证 Passkey。")
            await authenticate()
            if (view !== state) return
            result = await reveal()
        }
        if (view !== state) return
        displayCredential(result.password)
        status("gateway-account-status", "已验证账号密码。")
        element("gateway-visible-password").focus()
    }))
    element("gateway-hide").addEventListener("click", () => {
        clearCredential()
        if (!element("gateway-reveal").disabled) element("gateway-reveal").focus()
        else element("gateway-new-password").focus()
    })
    element("gateway-copy").addEventListener("click", perform(async () => {
        await navigator.clipboard.writeText(element("gateway-visible-password").value)
        if (view) status("gateway-account-status", "密码已复制。")
    }))

    return {bind, tick: () => readConnections(view)}
}
