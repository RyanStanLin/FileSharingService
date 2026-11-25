import {useEffect, useState} from 'react'
import {eventSocket} from '../api/events'

const topic = 'maintenance.changed'

export function useMaintenanceEvents(deviceId: string | undefined, refresh: () => void) {
  const [liveDevice, setLiveDevice] = useState<string>()

  useEffect(() => {
    setLiveDevice(undefined)
    if (!deviceId) return
    let disposed = false
    let socket: WebSocket | undefined
    let timer: number | undefined
    let delay = 1000

    function reconnect() {
      if (disposed) return
      setLiveDevice(undefined)
      timer = window.setTimeout(connect, delay)
      delay = Math.min(delay * 2, 15_000)
    }

    function connect() {
      let channel: WebSocket
      try { channel = eventSocket() } catch { reconnect(); return }
      socket = channel
      channel.onmessage = event => {
        if (disposed) return
        let frame: {type: string; id?: string}
        try { frame = JSON.parse(event.data) } catch { return }
        if (frame.type === 'ready') {
          channel.send(JSON.stringify({type: 'subscribe', id: topic, topic, deviceId}))
        } else if (frame.id === topic) {
          if (frame.type === 'subscribed') {
            setLiveDevice(deviceId)
            delay = 1000
            refresh()
          } else if (frame.type === 'event') refresh()
          else if (frame.type === 'error') channel.close()
        }
      }
      channel.onclose = reconnect
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (socket?.readyState === WebSocket.CONNECTING) {
        const channel = socket
        channel.onopen = () => channel.close()
      } else socket?.close()
    }
  }, [deviceId, refresh])

  return deviceId !== undefined && liveDevice === deviceId
}
