import {dialogFieldResults} from "./dialog-text-fields.js"
import {blankRow, dateText, element, facts, node, row, status} from "./ui.js"

const paths = {dialogs: "/interactions/dialogs", clipboard: "/clipboard/records"}
const outcomes = {submitted: "已提交", dismissed: "已取消", expired: "已超时"}

export function deviceRecords({call, perform}) {
    const kind = element("record-kind")
    const rows = element("records-rows")
    const refresh = element("records-refresh")
    const more = element("records-more")
    const detail = element("record-detail")
    let current

    function bind(id) {
        if ((!id && !current) || (current?.id === id && current?.kind === kind.value)) return
        current?.controller.abort()
        current?.detail?.abort()
        current = id ? {id, kind: kind.value, controller: new AbortController()} : undefined
        rows.replaceChildren()
        facts("record-detail-fields", [])
        detail.hidden = true
        more.hidden = true
        refresh.disabled = !current
        status("records-status", current ? "" : "请选择设备")
        if (current) void perform(() => list())()
    }

    function path(state) {
        return "/devices/" + encodeURIComponent(state.id) + paths[state.kind]
    }

    async function list(append = false) {
        const state = current
        if (!state || state.loading || (append && !state.cursor)) return
        state.loading = true
        refresh.disabled = true
        more.disabled = true
        status("records-status", "正在读取记录…")
        try {
            const query = new URLSearchParams({limit: "30"})
            if (append) query.set("cursor", state.cursor)
            const result = await call(path(state) + "?" + query, {signal: state.controller.signal})
            if (current !== state) return
            state.cursor = result.nextCursor
            const items = result.items.map(record => {
                const button = node("button", "查看详情")
                button.type = "button"
                button.addEventListener("click", perform(() => showDetail(state, record.id)))
                return state.kind === "clipboard"
                    ? row("剪贴板已更新", dateText(record.occurredAt), record.content, button)
                    : row(record.title ?? "原生对话框", dateText(record.recordedAt), outcomes[record.outcome] ?? record.outcome, button)
            })
            if (append) rows.append(...items)
            else rows.replaceChildren(...(items.length ? items : [blankRow("暂无记录", 4)]))
            more.hidden = !state.cursor
            status("records-status", "")
        } catch (error) {
            if (current === state && error.name !== "AbortError") status("records-status", "读取记录失败", true)
            throw error
        } finally {
            state.loading = false
            if (current === state) {
                refresh.disabled = false
                more.disabled = false
            }
        }
    }

    async function showDetail(state, id) {
        if (current !== state) return
        state.detail?.abort()
        const pending = new AbortController()
        state.detail = pending
        detail.hidden = true
        facts("record-detail-fields", [])
        const response = await call(path(state) + "/" + encodeURIComponent(id), {signal: pending.signal})
        if (current !== state || pending.signal.aborted) return
        const fields = state.kind === "clipboard" ? [
            ["记录 ID", response.id], ["事件", response.event], ["发生时间", response.occurredAt],
            ["入库时间", response.recordedAt], ["内容", response.content],
        ] : dialogDetails(response)
        facts("record-detail-fields", fields)
        detail.hidden = false
        element("record-detail-heading").focus()
    }

    kind.addEventListener("change", () => bind(current?.id))
    refresh.addEventListener("click", perform(() => list()))
    more.addEventListener("click", perform(() => list(true)))
    return {bind}
}

function dialogDetails({record, request, result}) {
    const choice = request?.choices.find(option => option.id === record.choiceId)?.label ?? record.choiceId
    const fields = [
        ["记录 ID", record.id], ["标题", record.title], ["提示文字", request?.message],
        ["结果", outcomes[record.outcome] ?? record.outcome], ["所选选项", choice],
        ["发出时间", record.createdAt], ["答复时间", result.respondedAt ?? record.recordedAt],
    ]
    if (result.text != null)
        fields.push(...dialogFieldResults([{id: "text", hintText: "用户答复", maskText: request?.maskText ?? true}], {text: result.text}))
    if (result.textValues) {
        const configured = request?.textFields ?? Object.keys(result.textValues).map(id => ({id, maskText: true}))
        fields.push(...dialogFieldResults(configured, result.textValues))
    }
    return fields
}
