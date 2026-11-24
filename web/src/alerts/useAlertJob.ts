import {useEffect, useState} from 'react'
import {readAlertJob, type AlertJob, type AlertSummary} from '../api/alerts'
import {ApiError} from '../api/client'
import {useRefresh, useResource} from '../ui/async'

interface TrackedAlert {
  id: string
  title?: string
  createdAt?: string
}

export function useAlertJob(deviceId: string, refreshHistory: () => void) {
  const key = `filesharing.alert-job.${deviceId}`
  const [active, setActive] = useState<TrackedAlert | undefined>(() => {
    const id = sessionStorage.getItem(key)
    return id ? {id} : undefined
  })
  const job = useResource(active?.id ?? null, signal => readAlertJob(active!.id, signal))
  const state = job.data?.state
  const gone = job.error instanceof ApiError && job.error.status === 404
  const waiting = Boolean(active && !gone && (state === undefined || state === 'queued'))
  const retryAfter = job.error instanceof ApiError ? job.error.retryAfterMs ?? 0 : 0
  const outcome = !state || state === 'queued' ? 'queued' : state === 'completed' ? job.data?.result?.outcome ?? 'failed' : state
  const item: AlertSummary | undefined = active && !gone ? {
    ...active, outcome, createdAt: job.data?.createdAt ?? active.createdAt, recordedAt: job.data?.result?.respondedAt,
  } : undefined

  useRefresh(waiting && !job.pending, job.refresh, job.error ? Math.max(retryAfter, 8_000) : 4_000, !job.error)
  useEffect(() => {
    if (!active || waiting) return
    if (sessionStorage.getItem(key) === active.id) sessionStorage.removeItem(key)
    if (state === 'completed') refreshHistory()
  }, [active, key, state, waiting, refreshHistory])

  function track(next: AlertJob, title: string) {
    sessionStorage.setItem(key, next.id)
    setActive({id: next.id, title, createdAt: next.createdAt})
  }

  return {item, waiting, track, refresh: job.refresh,
    error: waiting ? job.error : job.data?.error ? new ApiError(0, job.data.error) : undefined}
}
