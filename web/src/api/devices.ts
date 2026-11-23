import {ApiError, readAll, request, send, wait} from './client'
import type {Connection, Device, LocalRoot, Permissions, PermissionKind, Root} from './types'

export const deviceRoute = (id: string) => '/devices/' + encodeURIComponent(id)
export const readDevices = (signal?: AbortSignal) => readAll<Device>('/devices', signal)

export function setAccess(device: Device, enabled: boolean) {
  return send<Connection>(deviceRoute(device.id) + '/connection-access', 'PUT',
    {connectionId: device.connection.connectionId, enabled})
}

export async function readShares(deviceId: string, signal: AbortSignal) {
  const route = deviceRoute(deviceId) + '/file-roots'
  const [roots, local] = await Promise.all([readAll<Root>(route, signal), request<LocalRoot[]>(route + '/local', {signal})])
  const shares = local.flatMap(scope => {
    const root = roots.find(item => item.rootKey === scope.rootKey && item.enabled)
    return root ? [{...root, primary: scope.primary, writable: root.writable && scope.writable,
      folderPermissionWrites: scope.primary && !scope.writable && (root.writable || root.revision === 1)}] : []
  })
  shares.sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label))
  return {shares, roots, local}
}

export function saveGrant(deviceId: string, local: LocalRoot, root: Root | undefined, writable: boolean, signal: AbortSignal) {
  const route = deviceRoute(deviceId) + '/file-roots'
  const body = {rootKey: local.rootKey, label: root?.label ?? local.label, writable, enabled: true, revision: root?.revision}
  return root
    ? send<Root>(route + '/' + encodeURIComponent(root.id), 'PUT', body, {signal})
    : send<Root>(route, 'POST', body, {signal})
}

export async function readPermissions(deviceId: string, signal: AbortSignal) {
  try {
    return (await request<{value: Permissions}>(deviceRoute(deviceId) + '/permissions', {signal})).value
  } catch (error) {
    if (error instanceof ApiError && error.code === 'snapshot_unavailable') return {}
    throw error
  }
}

interface Job {
  id: string
  state: string
  error: string | null
}

export async function requestPermission(deviceId: string, kind: PermissionKind, signal: AbortSignal) {
  let job = await send<Job>(deviceRoute(deviceId) + '/permissions/requests', 'POST', {kind}, {signal})
  for (let attempt = 0; attempt < 150 && (job.state === 'queued' || job.state === 'running'); attempt++) {
    await wait(1000, signal)
    job = await request<Job>('/jobs/' + job.id, {signal})
  }
  if (job.state !== 'completed') throw new ApiError(503, job.error ?? 'permission_timeout')
}
