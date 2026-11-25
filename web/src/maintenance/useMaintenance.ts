import {useCallback, useEffect, useRef, useState} from 'react'
import {ApiError} from '../api/client'
import {endMaintenance, readMaintenance, startMaintenance, type MaintenanceStatus} from '../api/maintenance'
import type {Device} from '../api/types'
import {useRefresh} from '../ui/async'
import {useMaintenanceEvents} from './useMaintenanceEvents'

interface Reading {
  status?: MaintenanceStatus
  deadline?: number
  readError?: unknown
}

interface View extends Reading {
  deviceId?: string
  busy: boolean
  actionError?: unknown
}

interface Target {
  id: string
  read?: AbortController
  write?: AbortController
}

const empty: View = {busy: false}

function reading(status: MaintenanceStatus, previous: Reading): Reading {
  if (status.state !== 'active') return {status, deadline: undefined, readError: undefined}
  const now = performance.now()
  const earlierDeadline = previous.status?.leaseId === status.leaseId ? previous.deadline : undefined
  const deadline = Math.min(earlierDeadline ?? Infinity, now + status.remainingSeconds * 1000)
  return {status: deadline <= now ? {...status, state: 'expired'} : status, deadline, readError: undefined}
}

export function useMaintenance(device: Device | undefined, refreshDevice: () => void) {
  const deviceId = device?.id
  const connection = device?.connection
  const target = useRef<Target>(undefined)
  const [state, setState] = useState<View>(empty)
  const view = state.deviceId === deviceId ? state : empty
  const {status} = view
  const open = status?.state === 'active' || status?.state === 'preparing'
  const canStart = Boolean(!open && status?.supported && !view.readError && connection?.online &&
    connection.connectionId && connection.accessGranted)
  const canEnd = open && Boolean(status.leaseId)
  const deadline = status?.state === 'active' ? view.deadline : undefined
  const countdown = deadline === undefined ? undefined : new Date(Date.now() + deadline - performance.now()).toISOString()

  useEffect(() => {
    setState({deviceId, busy: false})
    if (!deviceId) return
    const current: Target = {id: deviceId}
    target.current = current
    return () => {
      target.current = undefined
      current.read?.abort()
      current.write?.abort()
    }
  }, [deviceId])

  const read = useCallback((replace: boolean) => {
    const current = target.current
    if (!current || current.id !== deviceId || current.write || (current.read && !replace)) return
    current.read?.abort()
    const controller = new AbortController()
    current.read = controller
    void readMaintenance(current.id, controller.signal).then(
      result => {
        if (!controller.signal.aborted) setState(previous => ({...previous, ...reading(result, previous)}))
      },
      readError => {
        if (!controller.signal.aborted) setState(previous => ({...previous, readError}))
      },
    ).finally(() => {
      if (current.read === controller) current.read = undefined
    })
  }, [deviceId])

  const refresh = useCallback(() => read(true), [read])
  const poll = useCallback(() => read(false), [read])
  const live = useMaintenanceEvents(deviceId, refresh)
  useRefresh(Boolean(deviceId), poll, status?.state === 'preparing' ? 2000 : live ? 30_000 : 8000)

  useEffect(() => { refresh() }, [refresh, connection?.connectionId, connection?.online, connection?.accessGranted])
  useEffect(() => {
    if (!deviceId) return
    function visible() { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [deviceId, poll])

  useEffect(() => {
    if (deadline === undefined) return
    const timer = window.setTimeout(() => {
      setState(previous => previous.deadline === deadline && previous.status?.state === 'active'
        ? {...previous, status: {...previous.status, state: 'expired'}} : previous)
      refresh()
    }, Math.max(0, deadline - performance.now()))
    return () => window.clearTimeout(timer)
  }, [deadline, refresh])

  async function toggle(enabled: boolean) {
    const current = target.current
    if (!current || current.id !== deviceId || current.write || !status) return
    const id = enabled ? connection?.connectionId : status.leaseId
    if (!id || !(enabled ? canStart : canEnd)) return

    const controller = new AbortController()
    current.write = controller
    current.read?.abort()
    current.read = undefined
    setState(previous => ({...previous, busy: true, actionError: undefined}))
    const {signal} = controller
    try {
      let result: MaintenanceStatus
      if (enabled) result = await startMaintenance(current.id, id, signal)
      else {
        await endMaintenance(current.id, id, signal)
        result = {...status, state: 'ended', remainingSeconds: 0}
      }
      if (!signal.aborted) setState(previous => ({...previous, ...reading(result, previous)}))
    } catch (actionError) {
      if (!signal.aborted) {
        setState(previous => ({...previous, actionError}))
        if (actionError instanceof ApiError && ['agent_connection_changed', 'agent_connection_ended',
          'agent_connection_access_required', 'device_unavailable'].includes(actionError.code)) refreshDevice()
      }
    } finally {
      current.write = undefined
      if (!signal.aborted) {
        setState(previous => ({...previous, busy: false}))
        refresh()
      }
    }
  }

  return {...view, countdown, open, canStart, canEnd, toggle, refresh}
}

export type MaintenanceControl = ReturnType<typeof useMaintenance>
