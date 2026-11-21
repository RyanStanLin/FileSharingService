import {useEffect, useMemo, useRef, useState} from 'react'
import {useDeviceEvents} from '../api/events'
import type {Location} from '../api/types'
import {useRefresh} from '../ui/async'
import {parent} from './navigation'

interface LiveFolder {
  device: string
  location?: Location
  ready: boolean
  snapshotRevision?: string
  refreshCurrent: () => void
  refreshDevice: () => void
  refreshPermissions: () => void
}

export function useLiveFolder({device, location, ready, snapshotRevision, refreshCurrent, refreshDevice,
  refreshPermissions}: LiveFolder) {
  const rootId = location?.rootId
  const path = location?.kind === 'file' ? parent(location.path) : location?.path
  const target = useMemo<Location | undefined>(() => rootId && path !== undefined ? {rootId, path, kind: 'folder'} : undefined, [rootId, path])
  const [armed, setArmed] = useState<Location>()
  const timer = useRef(0)
  const refresh = useRef(refreshCurrent)
  const snapshot = useRef(snapshotRevision)
  const lastEventRevision = useRef<string>(undefined)

  useEffect(() => { refresh.current = refreshCurrent }, [refreshCurrent])
  useEffect(() => { snapshot.current = snapshotRevision }, [snapshotRevision])
  useEffect(() => {
    if (!target || !ready) return
    const delay = window.setTimeout(() => setArmed(target), 600)
    return () => window.clearTimeout(delay)
  }, [target, ready])
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    timer.current = 0
    lastEventRevision.current = undefined
  }, [rootId, path])

  const watching = useDeviceEvents(device, armed === target ? target : undefined, refreshDevice, refreshPermissions, event => {
    if (event.rootId !== rootId || event.path !== path) return
    lastEventRevision.current = event.change?.revision
    if (timer.current || snapshot.current && lastEventRevision.current === snapshot.current) return
    timer.current = window.setTimeout(() => {
      timer.current = 0
      if (!snapshot.current || lastEventRevision.current !== snapshot.current) refresh.current()
    }, 400)
  })
  useRefresh(Boolean(location) && ready && !watching, refreshCurrent, 30_000, false)
}
