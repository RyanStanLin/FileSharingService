import {useEffect, useRef, useState} from 'react'
import {readRunningApps, readStatus, type Snapshot} from '../api/telemetry'
import {useRefresh, useResource} from '../ui/async'
import {streamWindows, type WindowStreamState} from './windowStream'

type MetadataTopic = 'displays' | 'apps-running'
type LiveSamples = Partial<Record<MetadataTopic, {sample: Snapshot; received: number}>>

export function useWindowActivity(deviceId: string, refreshDevice: () => void) {
  const [feed, setFeed] = useState<WindowStreamState>({mode: 'connecting'})
  const [live, setLive] = useState<LiveSamples>({})
  const [attempt, setAttempt] = useState(0)
  const received = useRef(0)
  const displays = useResource(deviceId, async signal => {
    const started = received.current
    const status = await readStatus(deviceId, signal)
    return {sample: status.samples.find(item => item.topic === 'displays'), started}
  })
  const apps = useResource(deviceId, async signal => {
    const started = received.current
    return {sample: await readRunningApps(deviceId, signal), started}
  })

  useEffect(() => streamWindows(deviceId, {
    state: setFeed,
    sample: sample => {
      const next = {sample, received: ++received.current}
      setLive(current => ({...current, [sample.topic]: next}))
    },
    connectionChanged: refreshDevice,
  }), [deviceId, attempt, refreshDevice])

  const interval = feed.mode === 'live' ? 60_000 : 5000
  useRefresh(true, displays.refresh, interval)
  useRefresh(true, apps.refresh, interval)

  function currentSample(topic: MetadataTopic) {
    const baseline = (topic === 'displays' ? displays : apps).data
    const saved = baseline?.sample
    const update = live[topic]
    if (!update) return saved
    if (!saved?.observedAt || !update.sample.observedAt) return update.sample
    const comparison = Date.parse(update.sample.observedAt) - Date.parse(saved.observedAt)
    return comparison > 0 || comparison === 0 && update.received > (baseline?.started ?? 0) ? update.sample : saved
  }

  function retry() {
    setAttempt(value => value + 1)
    displays.refresh()
    apps.refresh()
    refreshDevice()
  }

  return {...feed, displays: currentSample('displays'), apps: currentSample('apps-running'), retry}
}
