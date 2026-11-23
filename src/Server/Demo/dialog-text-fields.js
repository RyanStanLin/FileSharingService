import {element, node} from "./ui.js"

const maxFields = 6

export function dialogFieldEditor() {
    const mode = element("dialog-input")
    const section = element("dialog-text-fields")
    const list = element("dialog-text-field-list")
    const template = element("dialog-text-field-template")
    const add = element("dialog-add-text-field")
    let nextId = 1

    function update() {
        add.disabled = list.childElementCount >= maxFields
    }

    function append() {
        if (list.childElementCount >= maxFields) return
        const field = template.content.firstElementChild.cloneNode(true)
        const index = nextId++
        field.dataset.id = "field-" + index
        field.querySelector("legend").textContent = "输入框 " + index
        const remove = field.querySelector("[data-remove]")
        remove.setAttribute("aria-label", "移除输入框 " + index)
        remove.addEventListener("click", () => {
            field.remove()
            update()
            add.focus()
        })
        const mask = field.querySelector('[data-field="maskText"]')
        const initial = field.querySelector('[data-field="defaultText"]')
        mask.addEventListener("change", () => { initial.type = mask.checked ? "password" : "text" })
        list.append(field)
        update()
        return field.querySelector('[data-field="hintText"]')
    }

    function selectMode() {
        const editing = mode.value === "customFields"
        section.hidden = !editing
        section.disabled = !editing
        if (editing && !list.childElementCount) append()
    }

    add.addEventListener("click", () => append()?.focus())
    mode.addEventListener("change", selectMode)
    selectMode()
    return () => [...list.children].map(field => {
        const control = name => field.querySelector(`[data-field="${name}"]`)
        return {
            id: field.dataset.id,
            hintText: control("hintText").value || undefined,
            defaultText: control("defaultText").value,
            disabled: control("disabled").checked,
            required: control("required").checked,
            maskText: control("maskText").checked
        }
    })
}

export function dialogFieldResults(fields, values) {
    return fields.flatMap(field => {
        if (!Object.hasOwn(values, field.id)) return []
        const label = field.hintText?.trim() || "输入框 " + field.id.slice("field-".length)
        const value = values[field.id]
        if (!field.maskText || !value) return [[label, value]]
        const row = node("div", null, "row")
        const input = node("input")
        input.type = "password"
        input.readOnly = true
        input.autocomplete = "off"
        input.value = value
        input.setAttribute("aria-label", label)
        const toggle = node("button", "显示")
        toggle.type = "button"
        function reveal(shown) {
            input.type = shown ? "text" : "password"
            toggle.textContent = shown ? "遮蔽" : "显示"
            toggle.setAttribute("aria-label", toggle.textContent + " " + label)
        }
        toggle.addEventListener("click", () => reveal(input.type === "password"))
        reveal(false)
        row.append(input, toggle)
        return [[label, row]]
    })
}
