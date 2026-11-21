import {useEffect, useRef, useState} from 'react'
import {ApiError} from '../api/client'
import {browse, type Listing} from '../api/files'
import type {DirectoryPage, Entry, Location} from '../api/types'
import {useResource} from '../ui/async'

interface Continuation {
  pageIdentity: string
  latest: DirectoryPage
  entries: Entry[]
}

export function useDirectory(deviceId: string, location: Location | undefined, listing: Listing) {
  const key = location ? JSON.stringify([deviceId, location.rootId, location.path, listing]) : null
  const first = useResource(key, signal => browse(deviceId, location!, listing, signal))
  const [extra, setExtra] = useState<Continuation>()
  const [error, setError] = useState<unknown>()
  const [loadingMore, setLoadingMore] = useState(false)
  const active = useRef<AbortController | null>(null)

  const pageIdentity = first.data && key + first.data.revision
  useEffect(() => () => active.current?.abort(), [pageIdentity])
  useEffect(() => {
    setExtra(undefined)
    setError(undefined)
    setLoadingMore(false)
  }, [pageIdentity])

  const continuation = extra?.pageIdentity === pageIdentity ? extra : undefined
  const page = continuation?.latest ?? first.data
  const entries = continuation?.entries ?? first.data?.items ?? []

  async function next() {
    if (!location || !pageIdentity || !page || page.nextOffset === null || active.current) return
    const controller = new AbortController()
    active.current = controller
    setLoadingMore(true)
    setError(undefined)
    try {
      const result = await browse(deviceId, location, listing, controller.signal, page)
      if (!controller.signal.aborted) setExtra({pageIdentity, latest: result, entries: [...entries, ...result.items]})
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.code === 'snapshot_changed') first.refresh()
      else setError(cause)
    } finally {
      active.current = null
      if (!controller.signal.aborted) setLoadingMore(false)
    }
  }

  return {entries, page, next, loadingMore, error: error ?? first.error, pending: first.pending, refresh: first.refresh}
}
