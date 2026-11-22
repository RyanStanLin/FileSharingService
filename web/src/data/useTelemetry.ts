import {useCallback, useEffect, useRef, useState} from 'react'
import {activityTopics, readExtraSamples, readStatus, recentSince, samplingPolicy, snapshotTopics, trendTopics,
  type DeviceEvent, type History, type HistoryTopic, type Snapshot, type Snapshots, type SnapshotTopic, type TelemetryTopic} from '../api/telemetry'
import type {Connection, Device} from '../api/types'
import {useRefresh, useResource} from '../ui/async'
import {useTelemetryStream} from './useTelemetryStream'

interface LiveEvent {
  event: DeviceEvent
  received: number
}

type LiveEvents = Partial<Record<TelemetryTopic, LiveEvent>>

const historyTopics = new Set<TelemetryTopic>([...trendTopics, ...activityTopics])
const refreshInterval = 15_000

function newerSample(current: Snapshot | undefined, next: DeviceEvent, received: number, started: number) {
  if (!current) return true
  if (!current.observedAt) return received > started
  const comparison = Date.parse(next.time) - Date.parse(current.observedAt)
  return comparison > 0 || comparison === 0 && received > started
}

function connectionFrom(event?: DeviceEvent): Connection | undefined {
  const value = event?.payload
  if (value && typeof value === 'object' && 'online' in value && typeof value.online === 'boolean') return value as unknown as Connection
}

export function useTelemetry(device: Device, refreshDevice: () => void) {
  const received = useRef(0)
  const [live, setLive] = useState<LiveEvents>({})
  const [history, setHistory] = useState<History>({})
  const status = useResource(device.id, async signal => {
    const started = received.current
    return {data: await readStatus(device.id, signal), started}
  })
  const extras = useResource(device.id, async signal => {
    const started = received.current
    return {...await readExtraSamples(device.id, signal), started}
  })
  const policy = useResource(device.id, signal => samplingPolicy(device.id, signal))
  useRefresh(!policy.pending, policy.refresh, 30_000)
  const refresh = useCallback(() => {
    status.refresh()
    extras.refresh()
  }, [status.refresh, extras.refresh])
  const stream = useTelemetryStream(device.id, device.connection.online, event => {
    const observation = {event, received: ++received.current}
    setLive(current => ({...current, [event.topic]: observation}))
    if (historyTopics.has(event.topic)) {
      const topic = event.topic as HistoryTopic
      const cutoff = Date.parse(recentSince())
      setHistory(current => ({
        ...current,
        [topic]: [...(current[topic] ?? []).filter(item => Date.parse(item.time) >= cutoff), event],
      }))
    }
    if (event.topic === 'connection.changed') refreshDevice()
  })
  useRefresh(true, refresh, stream === 'live' ? 60_000 : refreshInterval)
  useEffect(() => {
    if (stream === 'live') refresh()
  }, [stream, refresh])
  const connectionKey = JSON.stringify([device.connection.online, device.connection.connectionId, device.connection.accessGranted])
  const previous = useRef(connectionKey)
  useEffect(() => {
    if (previous.current === connectionKey) return
    previous.current = connectionKey
    refresh()
  }, [connectionKey, refresh])

  const samples: Snapshots = {}
  for (const sample of [...(status.data?.data.samples ?? []), ...(extras.data?.samples ?? [])]) samples[sample.topic] = sample
  for (const topic of snapshotTopics) {
    const latest = live[topic]
    const started = status.data?.data.samples.some(sample => sample.topic === topic)
      ? status.data.started : extras.data?.started ?? 0
    if (latest && newerSample(samples[topic], latest.event, latest.received, started)) {
      samples[topic] = {topic, value: latest.event.payload, observedAt: latest.event.time, stale: false}
    }
  }

  const changed = live['connection.changed']
  const baseline = status.error ? device.connection : status.data?.data.connection ?? device.connection
  let connection = !status.error && changed && changed.received > (status.data?.started ?? 0)
    ? connectionFrom(changed.event) ?? baseline : baseline
  const quality = connectionFrom(live['connection.quality']?.event)
  if (connection.online && quality && quality.online && quality.connectionId === connection.connectionId &&
      Date.parse(quality.lastCommunicationAt ?? '') >= (Date.parse(connection.lastCommunicationAt ?? '') || 0)) {
    const {latencyMs, connectionSeconds, lastCommunicationAt} = quality
    connection = {...connection, latencyMs, connectionSeconds, lastCommunicationAt}
  }

  return {connection, samples, stream, history, policy, refresh,
    pending: (status.pending || extras.pending) && !status.data && !extras.data,
    error: status.error ?? extras.data?.error ?? extras.error}
}

export type TelemetryView = ReturnType<typeof useTelemetry>
export type SampleFor = (topic: SnapshotTopic) => Snapshot | undefined
