import {query, readAll, request, send} from './client'
import {deviceRoute} from './devices'
import type {Device, LocalRoot, Page, Root} from './types'
import type {DataObject} from './telemetry'

export const samplingTopics = ['cpu', 'memory', 'disk', 'battery', 'displays', 'network', 'system',
  'agent', 'power', 'storage', 'appsRunning'] as const

export type SamplingTopic = typeof samplingTopics[number]
export type Sampling = Record<SamplingTopic, number> & {keepAwake: boolean}

export interface CollectionProfile {
  id: string
  name: string
  revision: number
  settings: Sampling
}

export interface DevicePolicy {
  deviceId: string
  revision: number
  inherited: boolean
  settings: Sampling
}

export interface AuditRecord {
  id: string
  sequence: string
  time: string
  actor: string | null
  deviceId: string | null
  action: string
  detail: DataObject
}

const profileRoute = '/collection-profiles'

export const readProfiles = (signal: AbortSignal) => readAll<CollectionProfile>(profileRoute, signal)
export const readDevice = (id: string, signal: AbortSignal) => request<Device>(deviceRoute(id), {signal})
export const readPolicy = (id: string, signal: AbortSignal) => request<DevicePolicy>(deviceRoute(id) + '/policy', {signal})
export const readRoots = (id: string, signal: AbortSignal) => readAll<Root>(deviceRoute(id) + '/file-roots', signal)

export function updateDevice(device: Device, name: string, profileId: string, signal: AbortSignal) {
  return send<Device>(deviceRoute(device.id), 'PUT', {name, profileId, revision: device.revision}, {signal})
}

export function updatePolicy(policy: DevicePolicy, settings: Sampling | null, signal: AbortSignal) {
  return send<DevicePolicy>(deviceRoute(policy.deviceId) + '/policy', 'PUT', {revision: policy.revision, settings}, {signal})
}

export function saveProfile(profile: CollectionProfile | undefined, name: string, settings: Sampling, signal: AbortSignal) {
  return send<CollectionProfile>(profile ? profileRoute + '/' + encodeURIComponent(profile.id) : profileRoute,
    profile ? 'PUT' : 'POST', {name, settings, revision: profile?.revision}, {signal})
}

export const deleteProfile = (id: string, signal: AbortSignal) =>
  send<void>(profileRoute + '/' + encodeURIComponent(id), 'DELETE', undefined, {signal})

export const revokeDevice = (id: string, signal: AbortSignal) => send<void>(deviceRoute(id), 'DELETE', undefined, {signal})

export function writeRoot(deviceId: string, root: Root | undefined, local: LocalRoot, values: {
  label: string; writable: boolean; enabled: boolean
}, signal: AbortSignal) {
  const route = deviceRoute(deviceId) + '/file-roots'
  return send<Root>(root ? route + '/' + encodeURIComponent(root.id) : route, root ? 'PUT' : 'POST',
    {...values, rootKey: local.rootKey, revision: root?.revision}, {signal})
}

export const deleteRoot = (id: string, rootId: string, signal: AbortSignal) =>
  send<void>(deviceRoute(id) + '/file-roots/' + encodeURIComponent(rootId), 'DELETE', undefined, {signal})

export async function readAudit(cursor: string | undefined, deviceId: string | undefined, signal: AbortSignal): Promise<Page<AuditRecord>> {
  const page = await request<Page<Omit<AuditRecord, 'id'>>>(query('/audit', {cursor, deviceId, limit: 50}), {signal})
  return {...page, items: page.items.map(item => ({...item, id: item.sequence}))}
}
