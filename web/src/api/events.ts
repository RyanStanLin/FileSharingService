import {useEffect, useRef} from 'react'
import type {Location} from './types'

interface EventFrame {
  type: string
  id?: string
  item?: {topic: string}
}

export function useDeviceEvents(deviceId: string | null, folder: Location | undefined,
  onConnection: () => void, onPermissions: () => void, onFiles: () => void) {
  const callbacks = useRef({onConnection, onPermissions, onFiles})
  useEffect(() => { callbacks.current = {onConnection, onPermissions, onFiles} }, [onConnection, onPermissions, onFiles])

  const rootId = folder?.rootId
  const path = folder?.path
  useEffect(() => {
    if (!deviceId) return
    let closed = false
    let timer = 0
    let reconnectDelay = 1000
    let socket: WebSocket | undefined
    const url = new URL('/api/v1/events/ws', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    function connect() {
      if (closed) return
      const channel = new WebSocket(url)
      socket = channel
      channel.onmessage = event => {
        if (closed) return
        let frame: EventFrame
        try { frame = JSON.parse(event.data) as EventFrame } catch { return }
        if (frame.type === 'ready') {
          reconnectDelay = 1000
          for (const topic of ['connection.changed', 'permissions']) {
            channel.send(JSON.stringify({type: 'subscribe', id: topic, deviceId, topic}))
          }
          if (rootId && path !== undefined) {
            channel.send(JSON.stringify({type: 'subscribe', id: 'folder', deviceId, topic: 'files.changed', rootId, path}))
          }
        }
        if (frame.type === 'subscribed' && frame.id === 'folder') callbacks.current.onFiles()
        if (frame.type !== 'event') return
        if (frame.item?.topic === 'connection.changed') callbacks.current.onConnection()
        if (frame.item?.topic === 'permissions') callbacks.current.onPermissions()
        if (frame.item?.topic === 'files.changed') callbacks.current.onFiles()
      }
      channel.onclose = () => {
        if (closed) return
        timer = window.setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000)
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(timer)
      if (socket) {
        socket.onclose = null
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => socket?.close()
        } else socket.close()
      }
    }
  }, [deviceId, rootId, path])
}
