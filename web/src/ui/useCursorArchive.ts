import {useCallback, useEffect, useRef, useState} from 'react'
import type {Page} from '../api/types'

interface Archive<T> {
  page?: Page<T>
  loading: 'recent' | 'older' | null
  error?: unknown
  moreError?: unknown
}

function mergeRecent<T extends {id: string}>(current: Page<T> | undefined, recent: Page<T>) {
  if (!current?.items.length) return recent
  const overlap = recent.items.findIndex(item => item.id === current.items[0].id)
  if (overlap < 0) return recent
  if (overlap === 0) return current
  return {...current, items: [...recent.items.slice(0, overlap), ...current.items]}
}

export function useCursorArchive<T extends {id: string}>(key: string | null,
  readPage: (key: string, cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>) {
  const [archive, setArchive] = useState<Archive<T>>({loading: key === null ? null : 'recent'})
  const active = useRef<AbortController | null>(null)
  const queuedRefresh = useRef(false)

  const load = useCallback(async function read(cursor?: string) {
    if (key === null) return
    if (active.current) {
      if (cursor === undefined) queuedRefresh.current = true
      return
    }
    const controller = new AbortController()
    active.current = controller
    setArchive(current => cursor === undefined ? {...current, loading: 'recent', error: undefined}
      : {...current, loading: 'older', moreError: undefined})
    try {
      const incoming = await readPage(key, cursor, controller.signal)
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
  }, [key, readPage])

  const refresh = useCallback(() => { void load() }, [load])
  useEffect(() => {
    setArchive({loading: key === null ? null : 'recent'})
    if (key !== null) refresh()
    return () => {
      active.current?.abort()
      active.current = null
      queuedRefresh.current = false
    }
  }, [key, refresh])

  function next() {
    const cursor = archive.page?.nextCursor
    if (cursor != null) void load(cursor)
  }

  return {...archive, next, refresh}
}
