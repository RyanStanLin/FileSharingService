import {query, request, send} from './client'
import {deviceRoute} from './devices'
import type {Page} from './types'

export interface AlertChoice {
  id: string
  label: string
  isPrimary?: boolean
}

export interface AlertField {
  id: string
  hintText?: string | null
  required: boolean
  disabled: boolean
  maskText: boolean
}

export interface AlertRequest {
  title: string
  message: string
  choices: AlertChoice[]
  textFields?: (AlertField & {defaultText: string})[]
  requireLocalAuthentication?: boolean
}

type Outcome = 'submitted' | 'dismissed' | 'expired'

interface AlertResult {
  outcome: Outcome
  choiceId: string | null
  text: string | null
  textValues?: Record<string, string>
  respondedAt: string
  locallyAuthenticated?: boolean
}

export interface AlertSummary {
  id: string
  title?: string | null
  outcome: Outcome | 'queued' | 'cancelled' | 'failed'
  createdAt?: string
  recordedAt?: string | null
}

export interface AlertRecord extends AlertSummary {
  outcome: Outcome
  sequence: string
  createdAt: string
  recordedAt: string
}

export interface AlertDetail {
  record: AlertRecord
  request: (Pick<AlertRequest, 'title' | 'message' | 'choices' | 'requireLocalAuthentication'> & {
    askText: boolean
    textRequired: boolean
    maskText: boolean
    textFields: AlertField[] | null
  }) | null
  result: AlertResult
}

export interface AlertJob {
  id: string
  state: 'queued' | 'completed' | 'cancelled' | 'failed'
  createdAt: string
  finishedAt: string | null
  result: AlertResult | null
  error: string | null
}

export const alertJobKind = 'interaction.dialog'

function alertsRoute(deviceId: string) {
  return `${deviceRoute(deviceId)}/interactions/dialogs`
}

export function readAlerts(deviceId: string, cursor: string | undefined, signal: AbortSignal) {
  return request<Page<AlertRecord>>(query(alertsRoute(deviceId), {limit: 50, cursor}), {signal})
}

export function readAlert(deviceId: string, id: string, signal: AbortSignal) {
  return request<AlertDetail>(`${alertsRoute(deviceId)}/${encodeURIComponent(id)}`, {signal})
}

export function pushAlert(deviceId: string, alert: AlertRequest, signal: AbortSignal) {
  return send<AlertJob>(alertsRoute(deviceId), 'POST', alert, {signal})
}

export function readAlertJob(id: string, signal: AbortSignal) {
  return request<AlertJob>(`/jobs/${encodeURIComponent(id)}`, {signal})
}
