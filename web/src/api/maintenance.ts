import {request, send} from './client'
import {deviceRoute} from './devices'

export interface MaintenanceStatus {
  deviceId: string
  supported: boolean
  state: 'inactive' | 'preparing' | 'active' | 'ended' | 'expired'
  leaseId: string | null
  expiresAt: string | null
  remainingSeconds: number
}

const route = (deviceId: string) => deviceRoute(deviceId) + '/maintenance'

export function readMaintenance(deviceId: string, signal: AbortSignal) {
  return request<MaintenanceStatus>(route(deviceId), {signal})
}

export function startMaintenance(deviceId: string, connectionId: string, signal: AbortSignal) {
  return send<MaintenanceStatus>(route(deviceId), 'POST', {connectionId}, {signal})
}

export function endMaintenance(deviceId: string, leaseId: string, signal: AbortSignal) {
  return send<void>(route(deviceId) + '/' + encodeURIComponent(leaseId), 'DELETE', undefined, {signal})
}
