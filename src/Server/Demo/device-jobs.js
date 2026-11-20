import {dateText, element, facts, status} from "./ui.js"

const fields = {diagnostic: "diagnostic-fields", dialog: "dialog-fields", collection: "collect-telemetry"}
const ledgers = {diagnostic: "diagnostic-status", dialog: "dialog-status", collection: "collect-status"}
const results = {submitted: "Mac 用户已提交", dismissed: "Mac 用户已取消", expired: "等待答复超时"}

export function deviceJobs({call, perform, errorText, collectCompleted}) {
    let current
    const approvalValue = element("dialog-approval-value")
    const approvalToggle = element("dialog-approval-toggle")

    function showApprovalValue(revealed) {
        approvalValue.type = revealed ? "text" : "password"
        approvalToggle.textContent = revealed ? "遮蔽审批码" : "显示审批码"
    }

    approvalToggle.addEventListener("click", () => showApprovalValue(approvalValue.type === "password"))

    function renderApprovalCode(value) {
        showApprovalValue(false)
        approvalValue.value = value ?? ""
        element("dialog-approval").hidden = !value
    }

    function bind(device) {
        if (current?.id !== device?.id) {
            current?.controller.abort()
            current = device && {id: device.id, controller: new AbortController(), runs: {}}
            status("diagnostic-status", "")
            status("dialog-status", "")
            status("collect-status", "")
            element("diagnostic-stdout").textContent = ""
            element("diagnostic-stderr").textContent = ""
            facts("dialog-result", [])
            renderApprovalCode(null)
        }
        if (current) current.allowed = Boolean(device.connection.online && device.connection.accessGranted)
        renderControls()
    }

    function renderControls() {
        for (const [kind, id] of Object.entries(fields)) {
            const run = current?.runs[kind]
            element(id).disabled = !current?.allowed || (!!run && !run.finished)
        }
    }

    async function submit(kind, suffix, body) {
        const state = current
        if (!state?.allowed || (state.runs[kind] && !state.runs[kind].finished)) return
        const run = {kind, choices: body.choices, maskText: body.maskText === true, parts: new Map(), cursor: 0}
        state.runs[kind] = run
        status(ledgers[kind], "正在发送到 Mac…")
        if (kind === "dialog") {
            facts("dialog-result", [])
            renderApprovalCode(null)
        }
        if (kind === "diagnostic") renderOutput(run)
        renderControls()
        try {
            const job = await call("/devices/" + encodeURIComponent(state.id) + suffix,
                {method: "POST", body, signal: state.controller.signal})
            if (current !== state || state.runs[kind] !== run) return
            run.id = job.id
            status(ledgers[kind], kind === "dialog" ? "等待 Mac 用户答复…" : "等待设备回传…")
        } catch (error) {
            if (current !== state || error.name === "AbortError") return
            run.finished = true
            status(ledgers[kind], error.message, true)
            renderControls()
            return
        }
        await synchronize(state, run)
    }

    async function synchronize(state, run) {
        if (state !== current || !run.id || run.busy || run.finished) return
        run.busy = true
        const url = "/jobs/" + encodeURIComponent(run.id)
        const options = {signal: state.controller.signal}
        try {
            if (run.kind === "diagnostic") {
                const {items} = await call(url + "/output?after=" + run.cursor, options)
                if (state !== current) return
                for (const item of items) addPart(run, item)
                renderOutput(run)
            }
            const job = await call(url, options)
            if (state !== current) return
            if (job.state !== "queued") await finish(state, run, job)
        } catch (error) {
            if (state !== current || error.name === "AbortError") return
            if (error.status === 401) throw error
            if (error.status === 404) {
                run.finished = true
                renderControls()
            }
            status(ledgers[run.kind], error.message, true)
        } finally {
            run.busy = false
        }
    }

    function addPart(run, part) {
        if (part.index <= run.cursor || run.parts.has(part.index)) return
        run.parts.set(part.index, part)
        while (run.parts.has(run.cursor + 1)) run.cursor++
    }

    function renderOutput(run, result) {
        for (const stream of ["stdout", "stderr"]) {
            const target = element("diagnostic-" + stream)
            let output = result?.[stream]
            if (output == null) {
                output = ""
                const decoder = new TextDecoder()
                for (let index = 1; index <= run.cursor; index++) {
                    const part = run.parts.get(index)
                    if (part.stream !== stream) continue
                    output += decoder.decode(Uint8Array.from(atob(part.data), character => character.charCodeAt(0)), {stream: true})
                }
                if (run.finished) output += decoder.decode()
            }
            if (target.textContent !== output) target.textContent = output
        }
    }

    async function finish(state, run, job) {
        run.finished = true
        renderControls()
        if (job.state !== "completed") {
            if (run.kind === "diagnostic") renderOutput(run)
            status(ledgers[run.kind], errorText(job.error ?? job.state), true)
            return
        }
        if (run.kind === "diagnostic") {
            renderOutput(run, job.result)
            const result = job.result
            const details = ["退出码 " + (result.exitCode ?? "—"), result.timedOut && "超时", result.truncated && "输出已截断"].filter(Boolean)
            status("diagnostic-status", details.join(" · "), result.exitCode !== 0)
        } else if (run.kind === "dialog") {
            const result = job.result
            status("dialog-status", results[result.outcome] ?? result.outcome)
            const details = [["所选选项", run.choices.find(choice => choice.id === result.choiceId)?.label]]
            if (!run.maskText) details.push(["用户说明", result.text])
            details.push(["答复时间", dateText(result.respondedAt)])
            facts("dialog-result", details)
            if (run.maskText) renderApprovalCode(result.text)
        } else {
            status("collect-status", "设备已回传最新采样。")
            await collectCompleted()
        }
    }

    function receive({topic, payload, deviceId}) {
        const state = current
        if (!state || state.id !== deviceId) return
        if (topic === "jobs.output") {
            const run = state.runs.diagnostic
            if (!run?.id || run.id !== payload.jobId || run.finished) return
            addPart(run, payload)
            renderOutput(run)
            status("diagnostic-status", "正在通过 WebSocket 接收输出…")
        } else {
            const run = Object.values(state.runs).find(run => run.id === payload.id)
            if (run) void perform(() => synchronize(state, run))()
        }
    }

    const diagnosticKind = element("diagnostic-kind")
    const diagnosticCommand = element("diagnostic-command")
    function updateCommandField() {
        const custom = diagnosticKind.value === "custom"
        element("diagnostic-command-field").hidden = !custom
        element("diagnostic-examples").hidden = !custom
        diagnosticCommand.required = custom
    }
    diagnosticKind.addEventListener("change", updateCommandField)
    updateCommandField()
    element("diagnostic-form").addEventListener("submit", perform(() => {
        const kind = diagnosticKind.value
        const body = kind === "custom" ? {kind, command: diagnosticCommand.value} : {kind}
        return submit("diagnostic", "/diagnostics", body)
    }))
    element("dialog-form").addEventListener("submit", perform(() => {
        const mode = element("dialog-input").value
        const choices = [1, 2, 3].map(index => ({id: "choice-" + index, label: element("dialog-choice-" + index).value.trim()}))
            .filter(choice => choice.label)
        if (!choices.length || !element("dialog-title").value.trim() || !element("dialog-message").value.trim()) {
            status("dialog-status", "请输入标题、提示文字和至少一个选项。", true)
            return
        }
        return submit("dialog", "/interactions/dialogs", {
            title: element("dialog-title").value.trim(), message: element("dialog-message").value.trim(),
            choices, askText: mode !== "none", textRequired: mode === "required" || mode === "maskedRequired",
            maskText: mode === "maskedOptional" || mode === "maskedRequired",
            timeoutSeconds: element("dialog-timeout").valueAsNumber
        })
    }))

    return {
        bind, receive, collect: topics => submit("collection", "/refresh", {topics}),
        tick: async () => {
            const state = current
            if (state) await Promise.all(Object.values(state.runs).map(run => synchronize(state, run)))
        }
    }
}
