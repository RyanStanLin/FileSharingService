import {useEffect, useRef, useState} from 'react'
import type {Location} from './types'

export interface FileChange {
  rootId: string
  path: string
  change?: {revision?: string}
}

interface EventFrame {
  type: string
  id?: string
  item?: {topic: string; payload?: FileChange}
}

interface Watch {
  id: string
  key: string
  state: 'starting' | 'active' | 'stopping'
}

function folderKey(folder?: Location) {
  return folder && JSON.stringify([folder.rootId, folder.path])
}

export function useDeviceEvents(deviceId: string | null, folder: Location | undefined,
  onConnection: () => void, onPermissions: () => void, onFiles: (change: FileChange) => void) {
  const callbacks = useRef({onConnection, onPermissions, onFiles})
  const wanted = useRef(folder)
  const sync = useRef<() => void>(undefined)
  const [watching, setWatching] = useState<string>()
  useEffect(() => { callbacks.current = {onConnection, onPermissions, onFiles} }, [onConnection, onPermissions, onFiles])
  useEffect(() => {
    wanted.current = folder
    sync.current?.()
  }, [folder])

  useEffect(() => {
    setWatching(undefined)
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
      let nextId = 0
      let ready = false
      let watch: Watch | undefined
      let failedKey: string | undefined

      function reconcile() {
        const target = wanted.current
        const key = folderKey(target)
        if (!ready || closed || channel.readyState !== WebSocket.OPEN) return
        if (key !== failedKey) failedKey = undefined
        if (watch) {
          if (watch.key === key || watch.state !== 'active') return
          watch.state = 'stopping'
          setWatching(undefined)
          channel.send(JSON.stringify({type: 'unsubscribe', id: watch.id}))
        } else if (target && key && key !== failedKey) {
          watch = {id: 'folder-' + ++nextId, key, state: 'starting'}
          channel.send(JSON.stringify({type: 'subscribe', id: watch.id, deviceId, topic: 'files.changed',
            rootId: target.rootId, path: target.path}))
        }
      }

      sync.current = reconcile
      channel.onmessage = event => {
        if (closed) return
        let frame: EventFrame
        try { frame = JSON.parse(event.data) as EventFrame } catch { return }
        if (frame.type === 'ready') {
          ready = true
          reconnectDelay = 1000
          for (const topic of ['connection.changed', 'permissions']) {
            channel.send(JSON.stringify({type: 'subscribe', id: topic, deviceId, topic}))
          }
          reconcile()
          return
        }

        if (watch && frame.id === watch.id) {
          if (frame.type === 'subscribed') {
            watch.state = 'active'
            if (watch.key === folderKey(wanted.current)) setWatching(watch.key)
            reconcile()
          } else if (frame.type === 'unsubscribed' || frame.type === 'error') {
            if (frame.type === 'error') failedKey = watch.key
            watch = undefined
            setWatching(undefined)
            reconcile()
          } else if (frame.type === 'event' && frame.item?.payload && watch.key === folderKey(wanted.current)) {
            callbacks.current.onFiles(frame.item.payload)
          }
          return
        }

        if (frame.type !== 'event') return
        if (frame.item?.topic === 'connection.changed') callbacks.current.onConnection()
        if (frame.item?.topic === 'permissions') callbacks.current.onPermissions()
      }
      channel.onclose = () => {
        if (closed) return
        sync.current = undefined
        setWatching(undefined)
        timer = window.setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 15_000)
      }
    }
    connect()
    return () => {
      closed = true
      sync.current = undefined
      window.clearTimeout(timer)
      if (socket) {
        socket.onclose = null
        if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket?.close()
        else socket.close()
      }
    }
  }, [deviceId])

  return watching !== undefined && watching === folderKey(folder)
}
