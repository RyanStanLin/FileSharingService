import {useCallback, useEffect, useRef, useState} from 'react'
import {readClipboardRecords, type ClipboardRecord} from '../api/clipboard'
import type {Page} from '../api/types'
import {useRefresh} from '../ui/async'

interface Archive {
  page?: Page<ClipboardRecord>
  loading: 'recent' | 'older' | null
  error?: unknown
  moreError?: unknown
}

function mergeRecent(current: Page<ClipboardRecord> | undefined, recent: Page<ClipboardRecord>) {
  if (!current?.items.length) return recent
  const overlap = recent.items.findIndex(item => item.id === current.items[0].id)
  if (overlap < 0) return recent
  if (overlap === 0) return current
  return {...current, items: [...recent.items.slice(0, overlap), ...current.items]}
}

export function useClipboardArchive(deviceId: string | null, streaming: boolean, newestEvent: string | undefined) {
  const [archive, setArchive] = useState<Archive>({loading: 'recent'})
  const active = useRef<AbortController | null>(null)
  const queuedRefresh = useRef(false)
  const eventTimer = useRef<number | undefined>(undefined)
  const lastEvent = useRef(newestEvent)
  const wasStreaming = useRef(streaming)

  const load = useCallback(async function read(cursor?: string) {
    if (deviceId === null) return
    if (active.current) {
      if (cursor === undefined) queuedRefresh.current = true
      return
    }
    const controller = new AbortController()
    active.current = controller
    setArchive(current => cursor === undefined ? {...current, loading: 'recent', error: undefined}
      : {...current, loading: 'older', moreError: undefined})
    try {
      const incoming = await readClipboardRecords(deviceId, cursor, controller.signal)
      if (controller.signal.aborted) return
      setArchive(current => {
        if (cursor !== undefined && current.page) {
          return {...current, page: {
            items: [...current.page.items, ...incoming.items], nextCursor: incoming.nextCursor === cursor ? null : incoming.nextCursor,
          }}
        }
        const page = mergeRecent(current.page, incoming)
        return {...current, page, moreError: page === incoming ? undefined : current.moreError}
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        setArchive(current => cursor === undefined ? {...current, error} : {...current, moreError: error})
      }
    } finally {
      if (active.current === controller) active.current = null
      if (!controller.signal.aborted) {
        if (queuedRefresh.current) {
          queuedRefresh.current = false
          void read()
        } else setArchive(current => ({...current, loading: null}))
      }
    }
  }, [deviceId])

  const refresh = useCallback(() => { void load() }, [load])
  useEffect(() => {
    setArchive({loading: deviceId === null ? null : 'recent'})
    if (deviceId !== null) refresh()
    return () => {
      active.current?.abort()
      active.current = null
      queuedRefresh.current = false
      window.clearTimeout(eventTimer.current)
      eventTimer.current = undefined
    }
  }, [deviceId, refresh])
  useRefresh(deviceId !== null && !streaming, refresh, 15_000)
  useEffect(() => {
    if (streaming && !wasStreaming.current) refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])
  useEffect(() => {
    if (newestEvent === lastEvent.current) return
    lastEvent.current = newestEvent
    if (!deviceId || !newestEvent || eventTimer.current !== undefined) return
    eventTimer.current = window.setTimeout(() => {
      eventTimer.current = undefined
      refresh()
    }, 700)
  }, [deviceId, newestEvent, refresh])

  function next() {
    const cursor = archive.page?.nextCursor
    if (cursor != null) void load(cursor)
  }

  return {...archive, next, refresh}
}
