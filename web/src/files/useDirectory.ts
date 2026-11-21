import {useCallback, useEffect, useRef, useState} from 'react'
import {ApiError} from '../api/client'
import type {FileReadPriority} from '../api/fileReads'
import {browse, type Listing} from '../api/files'
import type {DirectoryPage, Entry, Location} from '../api/types'
import {useResource} from '../ui/async'

interface Continuation {
  pageIdentity: string
  latest: DirectoryPage
  entries: Entry[]
}

export function useDirectory(deviceId: string, location: Location | undefined, listing: Listing,
  priority: FileReadPriority = 'interactive') {
  const key = location ? JSON.stringify([deviceId, location.rootId, location.path, listing]) : null
  const first = useResource(key, signal => browse(deviceId, location!, listing, signal, undefined, priority))
  const [extra, setExtra] = useState<Continuation>()
  const [moreError, setMoreError] = useState<unknown>()
  const [loadingMore, setLoadingMore] = useState(false)
  const active = useRef<AbortController | null>(null)
  const refreshRequested = useRef(false)
  const refreshInFlight = useRef(false)
  const rebasedAt = useRef(-Infinity)

  const pageIdentity = first.data && key + first.data.revision
  useEffect(() => () => active.current?.abort(), [pageIdentity])
  useEffect(() => {
    setExtra(undefined)
    setMoreError(undefined)
    setLoadingMore(false)
  }, [pageIdentity])
  useEffect(() => {
    refreshRequested.current = false
    refreshInFlight.current = false
    rebasedAt.current = -Infinity
  }, [key])
  useEffect(() => {
    if (!first.pending) refreshInFlight.current = false
  }, [first.data, first.error, first.pending])

  const continuation = extra?.pageIdentity === pageIdentity ? extra : undefined
  const page = continuation?.latest ?? first.data
  const entries = continuation?.entries ?? first.data?.items ?? []

  const refreshFirst = useCallback(() => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    first.refresh()
  }, [first.refresh])

  const refresh = useCallback(() => {
    if (!key) return
    if (first.pending || active.current) refreshRequested.current = true
    else refreshFirst()
  }, [key, first.pending, refreshFirst])

  useEffect(() => {
    if (!key || first.pending || loadingMore || !refreshRequested.current) return
    refreshRequested.current = false
    refreshFirst()
  }, [key, first.pending, refreshFirst, loadingMore])

  async function next() {
    if (!location || !pageIdentity || !page || page.nextOffset === null || first.pending || active.current ||
      refreshInFlight.current || refreshRequested.current) return
    const controller = new AbortController()
    active.current = controller
    setLoadingMore(true)
    setMoreError(undefined)
    try {
      const result = await browse(deviceId, location, listing, controller.signal, page, priority)
      if (!controller.signal.aborted) setExtra({pageIdentity, latest: result, entries: [...entries, ...result.items]})
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.code === 'snapshot_changed' && performance.now() - rebasedAt.current > 3000) {
        rebasedAt.current = performance.now()
        refreshRequested.current = true
      } else {
        setMoreError(error)
      }
    } finally {
      if (active.current === controller) active.current = null
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }

  return {entries, page, next, loadingMore, moreError, error: first.error, pending: first.pending, refresh}
}

export type DirectoryView = ReturnType<typeof useDirectory>
