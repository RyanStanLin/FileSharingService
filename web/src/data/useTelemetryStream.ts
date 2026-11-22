import {useEffect, useRef, useState} from 'react'
import {eventSocket} from '../api/events'
import {streamTopics, type DeviceEvent, type TelemetryTopic} from '../api/telemetry'

type StreamStatus = 'connecting' | 'live' | 'polling' | 'offline'
type Frame =
  | {type: 'ready'; cursor: string}
  | {type: 'subscribed'; id: TelemetryTopic; cursor: string}
  | {type: 'event'; id: TelemetryTopic; item: DeviceEvent}
  | {type: 'error'; id: TelemetryTopic; code: string}

export function laterSequence(after: string, before: string) {
  return BigInt(after) > BigInt(before)
}

export function useTelemetryStream(deviceId: string, online: boolean, onEvent: (event: DeviceEvent) => void) {
  const update = useRef(onEvent)
  const [status, setStatus] = useState<StreamStatus>('connecting')
  useEffect(() => { update.current = onEvent }, [onEvent])

  useEffect(() => {
    if (!online) return
    let stopped = false
    const cursors = new Map<TelemetryTopic, string>()
    const ready = new Set<number>()
    setStatus('connecting')

    const close = streamTopics.map((topics, part) => {
      let socket: WebSocket | undefined
      let timer: number | undefined
      let delay = 1000

      function reconnect() {
        if (stopped) return
        ready.delete(part)
        setStatus('polling')
        timer = window.setTimeout(connect, delay)
        delay = Math.min(15_000, delay * 2)
      }

      function connect() {
        if (stopped) return
        let channel: WebSocket
        try { channel = eventSocket() } catch { reconnect(); return }
        socket = channel
        const acknowledged = new Set<TelemetryTopic>()
        const reset = new Set<TelemetryTopic>()

        function subscribe(topic: TelemetryTopic, after?: string) {
          channel.send(JSON.stringify({type: 'subscribe', id: topic, topic, deviceId, after}))
        }

        channel.onmessage = event => {
          if (stopped) return
          let frame: Frame
          try { frame = JSON.parse(event.data) as Frame } catch { return }
          if (frame.type === 'ready') {
            for (const topic of topics) subscribe(topic, cursors.get(topic) ?? frame.cursor)
            return
          }
          if (!topics.includes(frame.id)) return
          if (frame.type === 'subscribed') {
            acknowledged.add(frame.id)
            if (!cursors.has(frame.id)) cursors.set(frame.id, frame.cursor)
            if (acknowledged.size === topics.length) {
              ready.add(part)
              delay = 1000
              if (ready.size === streamTopics.length) setStatus('live')
            }
          } else if (frame.type === 'error') {
            if (frame.code === 'resync_required' && !reset.has(frame.id)) {
              reset.add(frame.id)
              cursors.delete(frame.id)
              subscribe(frame.id)
            } else channel.close()
          } else if (frame.type === 'event' && frame.item?.deviceId === deviceId && frame.item.topic === frame.id &&
              /^\d+$/.test(frame.item.sequence) && laterSequence(frame.item.sequence, cursors.get(frame.id) ?? '0')) {
            cursors.set(frame.id, frame.item.sequence)
            update.current(frame.item)
          }
        }
        channel.onclose = reconnect
      }

      connect()
      return () => {
        window.clearTimeout(timer)
        if (socket?.readyState === WebSocket.CONNECTING) {
          const channel = socket
          channel.onopen = () => channel.close()
        } else socket?.close()
      }
    })

    return () => {
      stopped = true
      for (const stop of close) stop()
    }
  }, [deviceId, online])
  return online ? status : 'offline'
}
