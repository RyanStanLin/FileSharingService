import {useCallback, useEffect, useRef, useState} from 'react'

interface Resource<T> {
  key: string | null
  data?: T
  error?: unknown
  pending: boolean
}

export function useResource<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>) {
  const source = useRef(read)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<Resource<T>>({key: null, pending: false})
  const refresh = useCallback(() => setRevision(value => value + 1), [])

  useEffect(() => { source.current = read }, [read])
  useEffect(() => {
    if (key === null) {
      setState({key, pending: false})
      return
    }
    const controller = new AbortController()
    setState(previous => ({key, data: previous.key === key ? previous.data : undefined, pending: true}))
    void source.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({key, data, pending: false}) },
      error => {
        if (!controller.signal.aborted) setState(previous => ({...previous, key, error, pending: false}))
      },
    )
    return () => controller.abort()
  }, [key, revision])

  return {...(state.key === key ? state : {key, pending: key !== null}), refresh}
}

export function useTask() {
  const active = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => () => active.current?.abort(), [])

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError(undefined)
    try {
      await work(controller.signal)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause)
    } finally {
      active.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return {busy, error, run}
}

export function useRefresh(active: boolean, refresh: () => void, interval: number, onFocus = true) {
  useEffect(() => {
    if (!active) return
    function refreshVisible() {
      if (document.visibilityState === 'visible') refresh()
    }
    const timer = window.setInterval(refreshVisible, interval)
    if (onFocus) window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [active, refresh, interval, onFocus])
}

export function useRefreshSignal(revision: number, refresh: () => void) {
  const previous = useRef(revision)
  useEffect(() => {
    if (previous.current === revision) return
    previous.current = revision
    refresh()
  }, [revision, refresh])
}
