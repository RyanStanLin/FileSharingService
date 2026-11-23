import {ApiError, wait} from '../api/client'
import {eventSocket} from '../api/events'
import type {DataValue, Snapshot} from '../api/telemetry'
import {readWindows, type WindowSnapshot} from '../api/windows'

const windowsTopic = 'windows.changed'
const metadataTopics = ['displays', 'apps-running'] as const
const reconnectDelay = 1000
const maxDelay = 15_000
const connectionErrors = new Set(['agent_connection_access_required', 'agent_connection_changed', 'agent_connection_ended', 'device_unavailable'])

export interface WindowStreamState {
  mode: 'connecting' | 'live' | 'polling'
  snapshot?: WindowSnapshot
  error?: unknown
}

interface Frame {
  type: string
  id?: string
  code?: string
  item?: {deviceId: string; topic: string; sequence: string; time: string; payload: unknown}
}

interface Listeners {
  state: (state: WindowStreamState) => void
  sample: (sample: Snapshot) => void
  connectionChanged: () => void
}

export function streamWindows(deviceId: string, listeners: Listeners) {
  let stopped = false
  let snapshot: WindowSnapshot | undefined
  let socket: WebSocket | undefined
  let poll: AbortController | undefined
  let reconnectTimer: number | undefined
  let handshakeTimer: number | undefined
  let delay = reconnectDelay

  function publish(mode: WindowStreamState['mode'], error?: unknown) {
    listeners.state({mode, snapshot, error})
  }

  function accept(next: WindowSnapshot) {
    if (snapshot && (next.revision === snapshot.revision || Date.parse(next.observedAt) < Date.parse(snapshot.observedAt))) return
    snapshot = next
  }

  function closeSocket() {
    window.clearTimeout(handshakeTimer)
    const channel = socket
    socket = undefined
    if (!channel) return
    channel.onmessage = channel.onerror = channel.onclose = null
    if (channel.readyState === WebSocket.CONNECTING) channel.onopen = () => channel.close()
    else channel.close()
  }

  function stopPolling() {
    poll?.abort()
    poll = undefined
  }

  function stop() {
    stopped = true
    window.clearTimeout(reconnectTimer)
    closeSocket()
    stopPolling()
  }

  function finishOnError(error: unknown) {
    if (!(error instanceof ApiError)) return false
    const changed = error.status === 403 || connectionErrors.has(error.code)
    if (!changed && error.code !== 'unsupported' && error.status !== 401) return false
    snapshot = undefined
    publish('polling', error)
    stop()
    if (changed) listeners.connectionChanged()
    return true
  }

  async function pollWindows(signal: AbortSignal) {
    let waitAfterError = reconnectDelay
    while (!signal.aborted) {
      try {
        const next = await readWindows(deviceId, snapshot?.revision, AbortSignal.any([signal, AbortSignal.timeout(18_000)]))
        if (signal.aborted) return
        if (next) accept(next)
        publish('polling')
        waitAfterError = reconnectDelay
      } catch (error) {
        if (signal.aborted || finishOnError(error)) return
        publish('polling', error)
        const retryAfter = error instanceof ApiError ? error.retryAfterMs ?? 0 : 0
        await wait(Math.max(waitAfterError, retryAfter), signal).catch(() => undefined)
        waitAfterError = Math.min(waitAfterError * 2, maxDelay)
      }
    }
  }

  function reconnect() {
    if (stopped) return
    closeSocket()
    if (!poll) {
      poll = new AbortController()
      publish('polling')
      void pollWindows(poll.signal)
    }
    reconnectTimer = window.setTimeout(connect, delay)
    delay = Math.min(delay * 2, maxDelay)
  }

  function connected() {
    window.clearTimeout(handshakeTimer)
    stopPolling()
    delay = reconnectDelay
    publish('live')
  }

  function connect() {
    if (stopped) return
    let channel: WebSocket
    try { channel = eventSocket() } catch { reconnect(); return }
    socket = channel
    let resume: string | undefined
    handshakeTimer = window.setTimeout(reconnect, 8000)
    channel.onerror = channel.onclose = reconnect
    channel.onmessage = event => {
      if (stopped || socket !== channel) return
      let frame: Frame
      try { frame = JSON.parse(event.data) as Frame } catch { return }
      if (frame.type === 'ready') {
        resume = snapshot?.revision
        for (const topic of [...metadataTopics, 'connection.changed', windowsTopic]) {
          channel.send(JSON.stringify({type: 'subscribe', id: topic, deviceId, topic,
            after: topic === windowsTopic ? resume : undefined}))
        }
      } else if (frame.type === 'subscribed' && frame.id === windowsTopic && resume && resume === snapshot?.revision) {
        connected()
      } else if (frame.type === 'error' && frame.id === windowsTopic) {
        if (!finishOnError(new ApiError(0, frame.code ?? 'request_failed'))) reconnect()
      } else if (frame.type === 'event' && frame.item?.deviceId === deviceId) {
        const {topic, payload, sequence, time} = frame.item
        if (topic === windowsTopic && frame.id === windowsTopic) {
          const next = payload as WindowSnapshot | null
          if (next?.revision !== sequence || !Array.isArray(next?.value?.windows) || !Array.isArray(next?.value?.displays)) return
          accept(next)
          connected()
        } else if (topic === 'displays' || topic === 'apps-running') {
          listeners.sample({topic, value: payload as DataValue, observedAt: time, stale: false})
        } else if (topic === 'connection.changed') listeners.connectionChanged()
      }
    }
  }

  publish('connecting')
  connect()
  return stop
}
