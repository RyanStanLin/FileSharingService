import {useEffect, useState} from 'react'
import {ApiError, sessionExpired} from '../api/client'
import {lock, register, status, unlock} from '../api/session'
import type {AuthStatus} from '../api/types'
import {useRefresh, useResource, useTask} from '../ui/async'

export function useSession() {
  const [transition, setTransition] = useState<AuthStatus>()
  const [setup, setSetup] = useState(false)
  const initial = useResource('session', status)
  const task = useTask()
  const current = transition ?? initial.data

  useRefresh(Boolean(current?.unlocked), initial.refresh, 30_000)
  useEffect(() => {
    if (!transition || initial.data?.unlocked !== transition.unlocked ||
        initial.data.initialized !== transition.initialized) return
    setTransition(undefined)
  }, [initial.data, transition])

  useEffect(() => {
    function expire() {
      setTransition({initialized: true, unlocked: false, session: null})
      initial.refresh()
    }
    window.addEventListener(sessionExpired, expire)
    return () => window.removeEventListener(sessionExpired, expire)
  }, [initial.refresh])

  function change(checked: boolean) {
    if (!current || task.busy) return
    if (checked && !current.initialized) {
      setSetup(true)
      return
    }
    void task.run(async signal => {
      const session = checked ? await unlock(signal) : (await lock(), null)
      setTransition({initialized: true, unlocked: !!session, session})
      initial.refresh()
    })
  }

  function initialize(secret: string) {
    void task.run(async signal => {
      try { await register(secret, signal) } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'passkey_already_configured') throw error
      }
      setSetup(false)
      setTransition({initialized: true, unlocked: false, session: null})
      initial.refresh()
      const session = await unlock(signal)
      setTransition({initialized: true, unlocked: true, session})
      initial.refresh()
    })
  }

  return {current, change, setup, initialize, closeSetup: () => setSetup(false), task, initial}
}
