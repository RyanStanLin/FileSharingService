import {ApiError, apiPrefix, query, request, response, send, wait} from './client'
import {deviceRoute} from './devices'
import type {Connection} from './types'

export type DataValue = null | boolean | number | string | DataValue[] | DataObject
export interface DataObject { [field: string]: DataValue }

export const statusTopics = ['identity', 'cpu', 'memory', 'disk', 'battery', 'power', 'system',
  'displays', 'locale', 'network', 'agent', 'lid'] as const

const extraPaths = {
  'apps-running': '/apps/running',
  'apps-installed': '/apps/installed',
  storage: '/storage',
  permissions: '/permissions',
  roots: '/file-roots/local',
} as const

const extraTopics = Object.keys(extraPaths) as (keyof typeof extraPaths)[]
export const snapshotTopics = [...statusTopics, ...extraTopics] as const
export type SnapshotTopic = typeof snapshotTopics[number]

export const trendTopics = ['cpu', 'memory', 'disk', 'battery', 'connection.quality'] as const
export const activityTopics = ['connection.changed', 'applications.changed', 'storage.changed', 'system.changed',
  'lid.changed', 'clipboard.changed', 'telemetry.gap', 'jobs.changed', 'transfers.changed'] as const
export type TrendTopic = typeof trendTopics[number]
export type ActivityTopic = typeof activityTopics[number]
export type HistoryTopic = TrendTopic | ActivityTopic
export type TelemetryTopic = SnapshotTopic | HistoryTopic

export const streamTopics: readonly (readonly TelemetryTopic[])[] = [
  [...statusTopics, 'connection.changed', 'connection.quality'],
  [...extraTopics, ...activityTopics.filter(topic => topic !== 'connection.changed')],
]

export interface Snapshot {
  topic: SnapshotTopic
  observedAt: string | null
  stale: boolean
  value: DataValue
}

export type Snapshots = Partial<Record<SnapshotTopic, Snapshot>>
export type History = Partial<Record<HistoryTopic, DeviceEvent[]>>

export interface DeviceEvent {
  deviceId: string
  topic: TelemetryTopic
  sequence: string
  time: string
  payload: DataValue
}

export interface DeviceStatus {
  deviceId: string
  connection: Connection
  samples: Snapshot[]
}

interface HistoryPage {
  items: DeviceEvent[]
  cursor: string
  hasMore: boolean
}

interface SamplingJob {
  id: string
  state: string
  error: string | null
}

export const recentMinutes = 30
export const recentSince = () => new Date(Date.now() - recentMinutes * 60_000).toISOString()

export function readStatus(deviceId: string, signal: AbortSignal) {
  return request<DeviceStatus>(deviceRoute(deviceId) + '/status', {signal})
}

export async function readExtraSamples(deviceId: string, signal: AbortSignal) {
  const route = deviceRoute(deviceId)
  const results = await Promise.allSettled(extraTopics.map(async (topic): Promise<Snapshot> => {
    const path = route + extraPaths[topic]
    if (topic === 'roots') return {topic, value: await request<DataValue>(path, {signal}), observedAt: null, stale: false}
    return request<Snapshot>(path, {signal})
  }))
  const samples: Snapshot[] = []
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') samples.push(result.value)
    else if (!(result.reason instanceof ApiError && result.reason.code === 'snapshot_unavailable')) errors.push(result.reason)
  }
  return {samples, error: errors[0]}
}

export function samplingPolicy(deviceId: string, signal: AbortSignal) {
  return request<DataObject>(deviceRoute(deviceId) + '/policy', {signal})
}

function appIconPath(deviceId: string, applicationId: string) {
  return query(deviceRoute(deviceId) + '/apps/icon', {applicationId})
}

export function appIconUrl(deviceId: string, applicationId: string) {
  return apiPrefix + appIconPath(deviceId, applicationId)
}

export async function appIcon(deviceId: string, applicationId: string, signal: AbortSignal) {
  return (await response(appIconPath(deviceId, applicationId), {signal})).blob()
}

export function readHistoryPage(deviceId: string, topic: HistoryTopic, from: string, signal: AbortSignal, after?: string) {
  return request<HistoryPage>(query(deviceRoute(deviceId) + '/history', {topic, from, after, limit: 200}), {signal})
}

export async function requestSample(deviceId: string, signal: AbortSignal) {
  let job = await send<SamplingJob>(deviceRoute(deviceId) + '/refresh', 'POST', {topics: snapshotTopics}, {signal})
  for (let attempt = 0; attempt < 60 && ['queued', 'running'].includes(job.state); attempt++) {
    await wait(1000, signal)
    job = await request<SamplingJob>('/jobs/' + encodeURIComponent(job.id), {signal})
  }
  if (job.state !== 'completed') throw new ApiError(503, job.error ?? 'data_sampling_failed')
}
