import {useEffect, useRef, useState} from 'react'
import {eventSocket} from '../api/events'
import type {NotificationUpdate} from '../api/notificationTypes'

interface UpdateFrame {
  type: string
  id?: string
  cursor?: string
  code?: string
  item?: {sequence: string; payload: NotificationUpdate}
}

export function useNotificationUpdates(onChange: (update?: NotificationUpdate) => void, enabled = true) {
  const callback = useRef(onChange)
  const [live, setLive] = useState(false)
  useEffect(() => { callback.current = onChange }, [onChange])
  useEffect(() => {
    if (!enabled) { setLive(false); return }
    const id = 'notification-updates'
    let cursor: string | undefined
    let finished = false
    let timer = 0
    let delay = 1000
    let socket: WebSocket | undefined

    function connect() {
      if (finished) return
      const channel = eventSocket()
      socket = channel
      function subscribe() {
        channel.send(JSON.stringify({type: 'subscribe', id, topic: 'notifications.changed', after: cursor}))
      }
      channel.onmessage = ({data}) => {
        if (finished) return
        let frame: UpdateFrame
        try { frame = JSON.parse(data) } catch { return }
        if (frame.type === 'ready') subscribe()
        if (frame.id !== id) return
        if (frame.type === 'subscribed') {
          cursor = frame.cursor
          delay = 1000
          setLive(true)
          callback.current()
        } else if (frame.type === 'event' && frame.item) {
          cursor = frame.item.sequence
          callback.current(frame.item.payload)
        } else if (frame.type === 'error' && frame.code === 'notification_resync_required') {
          cursor = undefined
          subscribe()
        }
      }
      channel.onclose = () => {
        if (finished) return
        setLive(false)
        timer = window.setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30_000)
      }
    }
    connect()
    return () => {
      finished = true
      window.clearTimeout(timer)
      if (!socket) return
      socket.onclose = null
      socket.onmessage = null
      if (socket.readyState === WebSocket.CONNECTING) {
        const closing = socket
        socket.onopen = () => closing.close()
      } else socket.close()
    }
  }, [enabled])
  return live
}
