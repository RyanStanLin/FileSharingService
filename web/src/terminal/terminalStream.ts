import {ApiError} from '../api/client'
import {openTerminalSocket, readTerminalOutput, sendTerminalInput, type TerminalAddress, type TerminalInput, type TerminalOutput} from '../api/terminals'

type InputAck = {type: 'input'; id: string; code: string | null}
type Mode = 'connecting' | 'live' | 'polling' | 'complete'
type Reply = (ack: InputAck | null) => void

interface Listeners {
  page: (page: TerminalOutput) => void
  mode: (mode: Mode, error?: unknown) => void
}

export function streamTerminal(address: TerminalAddress, listeners: Listeners, archived: boolean) {
  const abort = new AbortController()
  const replies = new Map<string, Reply>()
  let cursor = 0
  let complete = false
  let reconnectAt = 0
  let failureDelay = 1000
  let timer: number | undefined
  let socket: WebSocket | undefined

  function accept(page: TerminalOutput) {
    if (abort.signal.aborted || page.cursor < cursor) return
    const items = page.items.filter(frame => frame.index > cursor)
    cursor = page.cursor
    complete = page.closed
    listeners.page({...page, items})
    if (complete) listeners.mode('complete')
  }

  function reconnect() {
    if (abort.signal.aborted || complete) return
    reconnectAt = Date.now() + 12_000
    listeners.mode('polling')
    void poll()
  }

  async function poll() {
    if (abort.signal.aborted || complete) return
    let delay = 500
    try {
      const page = await readTerminalOutput(address, cursor, AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]))
      accept(page)
      if (complete || abort.signal.aborted) return
      listeners.mode('polling')
      failureDelay = 1000
      if (page.hasMore) delay = 0
      else if (!archived && Date.now() >= reconnectAt) {
        connect()
        return
      }
    } catch (error) {
      if (abort.signal.aborted) return
      listeners.mode('polling', error)
      if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) return
      delay = Math.max(failureDelay, error instanceof ApiError ? error.retryAfterMs ?? 0 : 0)
      failureDelay = Math.min(failureDelay * 2, 12_000)
    }
    timer = window.setTimeout(poll, delay)
  }

  function connect() {
    let channel: WebSocket
    try { channel = openTerminalSocket(address, cursor) } catch { reconnect(); return }
    socket = channel
    timer = window.setTimeout(() => channel.close(), 4000)
    channel.onopen = () => {
      window.clearTimeout(timer)
      listeners.mode('live')
    }
    channel.onmessage = event => {
      if (abort.signal.aborted) return
      let data: TerminalOutput | InputAck
      try { data = JSON.parse(event.data) as TerminalOutput | InputAck } catch { return }
      if ('type' in data && data.type === 'input') replies.get(data.id)?.(data)
      else if ('items' in data && Array.isArray(data.items)) accept(data)
    }
    channel.onerror = () => channel.close()
    channel.onclose = () => {
      window.clearTimeout(timer)
      socket = undefined
      for (const reply of replies.values()) reply(null)
      reconnect()
    }
  }

  async function input(packet: TerminalInput) {
    abort.signal.throwIfAborted()
    const channel = socket
    if (channel?.readyState === WebSocket.OPEN) {
      const ack = await new Promise<InputAck | null>(resolve => {
        const timeout = window.setTimeout(() => finish(null), 7500)
        function finish(value: InputAck | null) {
          window.clearTimeout(timeout)
          replies.delete(packet.id)
          resolve(value)
        }
        replies.set(packet.id, finish)
        try { channel.send(JSON.stringify(packet)) } catch { finish(null) }
      })
      if (ack) {
        if (ack.code) throw new ApiError(409, ack.code)
        return
      }
      if (channel === socket) channel.close()
    }
    await sendTerminalInput(address, packet, AbortSignal.any([abort.signal, AbortSignal.timeout(9000)]))
  }

  if (archived) void poll()
  else connect()
  return {
    input,
    stop() {
      abort.abort()
      window.clearTimeout(timer)
      for (const reply of replies.values()) reply(null)
      if (!socket) return
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      if (socket.readyState === WebSocket.CONNECTING) {
        const pending = socket
        pending.onopen = () => pending.close()
      } else socket.close()
    },
  }
}
