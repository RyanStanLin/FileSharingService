import {apiPrefix, ApiError, query, request, response, send, wait} from './client'
import {deviceRoute} from './devices'
import type {Page} from './types'

export interface TerminalSession {
  id: string
  deviceId: string
  rootId: string
  interactive: boolean
  state: 'starting' | 'open' | 'terminating' | 'terminated'
  connected: boolean
  canControl: boolean
  commandId: string | null
  commandStarted: boolean
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  code: string | null
  firstCommand?: string | null
}

export type TerminalFrame = {index: number; at?: number} & (
  | {kind: 'ready'; prompt?: string}
  | {kind: 'command'; commandId: string; line: string; prompt?: string}
  | {kind: 'started'; commandId: string}
  | {kind: 'output'; commandId: string; data: string}
  | {kind: 'exit'; commandId: string; exitCode: number; code?: string; prompt?: string}
  | {kind: 'terminating' | 'closed'; code?: string}
)

export type TerminalInput = (
  | {kind: 'keys'; commandId: string; data: string}
  | {kind: 'resize'; rows: number; columns: number}
) & {id: string}

export interface TerminalOutput {
  items: TerminalFrame[]
  cursor: number
  hasMore: boolean
  closed: boolean
  session: TerminalSession
}

export interface TerminalAddress {deviceId: string; id: string}

const sessionsRoute = (deviceId: string) => `${deviceRoute(deviceId)}/diagnostics/sessions`
const route = ({deviceId, id}: TerminalAddress) => `${sessionsRoute(deviceId)}/${encodeURIComponent(id)}`

function list(deviceId: string, signal: AbortSignal, limit: number, cursor?: string | null) {
  return request<Page<TerminalSession> & {active: TerminalSession | null}>(
    query(sessionsRoute(deviceId), {limit, cursor}), {signal})
}

export async function readTerminalCatalog(deviceId: string, signal: AbortSignal) {
  const sessions = new Map<string, TerminalSession>()
  let cursor: string | null = null
  do {
    const page = await list(deviceId, signal, 200, cursor)
    if (page.active) sessions.set(page.active.id, page.active)
    for (const session of page.items) if (!sessions.has(session.id)) sessions.set(session.id, session)
    cursor = page.nextCursor
  } while (cursor)
  return [...sessions.values()]
}

export const createTerminal = (deviceId: string, signal: AbortSignal) =>
  send<TerminalSession>(sessionsRoute(deviceId), 'POST', {}, {signal})

export async function prepareQuickTerminal(deviceId: string, signal: AbortSignal) {
  const {active} = await list(deviceId, signal, 1)
  if (active) return active
  try {
    return await createTerminal(deviceId, signal)
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'terminal_busy') throw error
    const {active: latest} = await list(deviceId, signal, 1)
    if (!latest) throw error
    return latest
  }
}

export function readTerminal(address: TerminalAddress, signal: AbortSignal) {
  return request<TerminalSession>(route(address), {signal})
}

export async function awaitTerminalControl(session: TerminalSession, signal: AbortSignal) {
  const deadline = Date.now() + 8000
  while (session.state === 'starting' && Date.now() < deadline) {
    await wait(350, signal)
    session = await readTerminal(session, signal)
  }
  if (session.state !== 'open') throw new ApiError(409, session.code ?? 'terminal_not_ready')
  if (!session.connected) throw new ApiError(409, 'terminal_detached')
  if (!session.canControl) throw new ApiError(403, 'agent_connection_access_required')
  if (session.commandId) throw new ApiError(409, 'terminal_busy')
  return session
}

export const readTerminalOutput = (address: TerminalAddress, after: number, signal: AbortSignal) =>
  request<TerminalOutput>(query(route(address) + '/output', {after}), {signal})

export function openTerminalSocket(address: TerminalAddress, after: number) {
  const url = new URL(apiPrefix + query(route(address) + '/ws', {after}), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url)
}

export const runTerminalCommand = (address: TerminalAddress, line: string, signal: AbortSignal) =>
  send<{commandId: string}>(route(address) + '/commands', 'POST', {line}, {signal})

export const interruptTerminal = (address: TerminalAddress, signal: AbortSignal) =>
  send<void>(route(address) + '/interrupt', 'POST', undefined, {signal})

export const sendTerminalInput = (address: TerminalAddress, input: TerminalInput, signal: AbortSignal) =>
  send<void>(route(address) + '/input', 'POST', input, {signal})

export async function terminateTerminal(address: TerminalAddress, signal: AbortSignal) {
  await response(route(address) + '/terminate', {method: 'POST', signal})
}

export const deleteTerminal = (address: TerminalAddress, signal: AbortSignal) =>
  send<void>(route(address), 'DELETE', undefined, {signal})

export const terminalDownload = (address: TerminalAddress) => apiPrefix + route(address) + '/transcript'
