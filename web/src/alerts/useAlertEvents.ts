import {useEffect, useRef, useState} from 'react'
import {alertJobKind} from '../api/alerts'
import {eventSocket} from '../api/events'

const topic = 'jobs.changed'

interface Frame {
  type: string
  id?: string
  item?: {deviceId: string; topic: string; payload?: {id?: string; kind?: string}}
}

export function useAlertEvents(deviceId: string, changed: (id?: string) => void) {
  const callback = useRef(changed)
  const [live, setLive] = useState(false)
  useEffect(() => { callback.current = changed }, [changed])

  useEffect(() => {
    let socket: WebSocket | undefined
    let stopped = false
    let timer: number | undefined
    let delay = 1000

    function close() {
      window.clearTimeout(timer)
      const channel = socket
      socket = undefined
      if (!channel) return
      channel.onmessage = channel.onclose = channel.onerror = null
      if (channel.readyState === WebSocket.CONNECTING) channel.onopen = () => channel.close()
      else channel.close()
    }

    function reconnect() {
      if (stopped) return
      setLive(false)
      close()
      timer = window.setTimeout(connect, delay)
      delay = Math.min(delay * 2, 15_000)
    }

    function connect() {
      if (stopped) return
      let channel: WebSocket
      try { channel = eventSocket() } catch { reconnect(); return }
      socket = channel
      timer = window.setTimeout(reconnect, 8000)
      channel.onclose = channel.onerror = reconnect
      channel.onmessage = event => {
        if (socket !== channel) return
        let frame: Frame
        try { frame = JSON.parse(event.data) as Frame } catch { return }
        if (frame.type === 'ready') {
          channel.send(JSON.stringify({type: 'subscribe', id: topic, deviceId, topic}))
        } else if (frame.id === topic && frame.type === 'subscribed') {
          window.clearTimeout(timer)
          delay = 1000
          setLive(true)
          callback.current()
        } else if (frame.id === topic && frame.type === 'error') {
          reconnect()
        } else if (frame.type === 'event' && frame.item?.deviceId === deviceId && frame.item.topic === topic &&
          frame.item.payload?.kind === alertJobKind && frame.item.payload.id) {
          callback.current(frame.item.payload.id)
        }
      }
    }

    connect()
    return () => { stopped = true; close() }
  }, [deviceId])
  return live
}
