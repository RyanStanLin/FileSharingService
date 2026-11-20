export const element = id => document.getElementById(id)

export function status(id, text, failed = false) {
    const node = element(id)
    if (node.textContent !== text) node.textContent = text
    node.toggleAttribute("data-error", failed)
}

export function node(tag, value, className) {
    const item = document.createElement(tag)
    if (value != null) item.textContent = value
    if (className) item.className = className
    return item
}

export function row(...values) {
    const result = node("tr")
    for (const value of values) {
        const cell = node("td")
        if (value instanceof Node) cell.append(value)
        else cell.textContent = value ?? "—"
        result.append(cell)
    }
    return result
}

export function stack(...lines) {
    const container = node("div")
    for (const [index, line] of lines.entries()) {
        if (line != null && line !== "") container.append(node("span", line, index ? "stack-line muted" : "stack-line"))
    }
    return container
}

export function facts(id, values) {
    element(id).replaceChildren(...values.flatMap(([label, text]) => [node("dt", label), node("dd", text ?? "—")]))
}

export function blankRow(text, columns) {
    const placeholder = row(text)
    placeholder.firstElementChild.colSpan = columns
    return placeholder
}

const number = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 1})
const timeFormat = new Intl.DateTimeFormat("zh-CN", {month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"})

export function dateText(value) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timeFormat.format(timestamp) : "—"
}

export function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—"
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
    const unit = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10))
    return number.format(value / 1024 ** unit) + " " + units[unit]
}

export function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—"
    const value = Math.floor(seconds)
    const days = Math.floor(value / 86400)
    const hours = Math.floor(value / 3600) % 24
    const minutes = Math.floor(value / 60) % 60
    return [days && days + " 天", hours && hours + " 小时", minutes && minutes + " 分钟",
        !days && !hours && value % 60 + " 秒"].filter(Boolean).join(" ")
}

export function eventRow(time, label, text) {
    const item = node("li")
    const stamp = node("time", dateText(time))
    stamp.dateTime = time
    item.append(stamp, node("strong", label), node("span", text))
    return item
}

export function eventSocket() {
    const url = new URL("/api/v1/events/ws", location.href)
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
    return new WebSocket(url)
}
