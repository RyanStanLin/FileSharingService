import {ApiError} from '../api/client'
import type {TerminalInput} from '../api/terminals'

type Pending = {kind: 'keys'; commandId: string; bytes: Uint8Array} | {kind: 'resize'; rows: number; columns: number}
const chunkSize = 4096
const queueCapacity = 65_536

export function terminalInput(send: (input: TerminalInput) => Promise<void>, report: (error: unknown) => void) {
  const queue: Pending[] = []
  let queuedBytes = 0
  let closed = false
  let sending = false
  let timer: number | undefined

  async function drain() {
    timer = undefined
    sending = true
    try {
      while (!closed && queue.length) {
        const packet = queue.shift()!
        const id = crypto.randomUUID()
        try {
          if (packet.kind === 'resize') await send({...packet, id})
          else {
            queuedBytes -= packet.bytes.length
            await send({kind: 'keys', commandId: packet.commandId, data: btoa(String.fromCharCode(...packet.bytes)), id})
          }
        } catch (error) {
          if (!closed && !(error instanceof ApiError && error.code === 'terminal_command_ended')) report(error)
        }
      }
    } finally { sending = false }
  }

  function schedule() {
    if (timer === undefined && !sending) timer = window.setTimeout(drain, 12)
  }

  return {
    keys(commandId: string, bytes: Uint8Array) {
      if (closed || !bytes.length) return
      if (queuedBytes + bytes.length > queueCapacity) {
        report(new ApiError(400, 'terminal_input_too_large'))
        return
      }
      queuedBytes += bytes.length
      for (let offset = 0; offset < bytes.length;) {
        const last = queue.at(-1)
        if (last?.kind === 'keys' && last.commandId === commandId && last.bytes.length < chunkSize) {
          const part = bytes.subarray(offset, offset + chunkSize - last.bytes.length)
          const merged = new Uint8Array(last.bytes.length + part.length)
          merged.set(last.bytes)
          merged.set(part, last.bytes.length)
          last.bytes = merged
          offset += part.length
        } else {
          const part = bytes.subarray(offset, offset + chunkSize)
          queue.push({kind: 'keys', commandId, bytes: part})
          offset += part.length
        }
      }
      schedule()
    },
    resize(rows: number, columns: number) {
      if (closed) return
      const frame = {kind: 'resize', rows, columns} as const
      if (queue.at(-1)?.kind === 'resize') queue[queue.length - 1] = frame
      else queue.push(frame)
      schedule()
    },
    stop() {
      closed = true
      queue.length = 0
      window.clearTimeout(timer)
    },
  }
}
