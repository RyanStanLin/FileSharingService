import {query, request} from './client'
import {deviceRoute} from './devices'
import type {Page} from './types'

export interface ClipboardRecord {
  id: string
  deviceId: string
  event: string
  occurredAt: string
  recordedAt: string
  content: string | null
}

function recordsRoute(deviceId: string) {
  return deviceRoute(deviceId) + '/clipboard/records'
}

export function readClipboardRecords(deviceId: string, cursor: string | undefined, signal: AbortSignal) {
  return request<Page<ClipboardRecord>>(query(recordsRoute(deviceId), {limit: 50, cursor}), {signal})
}

export function readClipboardRecord(deviceId: string, id: string, signal: AbortSignal) {
  return request<ClipboardRecord>(recordsRoute(deviceId) + '/' + encodeURIComponent(id), {signal})
}
