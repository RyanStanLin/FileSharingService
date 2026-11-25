import {query, readAll, request, send} from './client'

export type GatewayMode = 'ftp' | 'ftps' | 'sftp'
export type GatewayScope = 'activeHomes' | 'grants'

export interface GatewayEndpoint {
  mode: 'plain' | 'explicitTls' | 'implicitTls' | 'sftp'
  address: string
  hostKeyFingerprint?: string
  available?: boolean
}

export interface GatewayAccount {
  id: string
  name: string
  mode: GatewayMode
  disabled: boolean
  revision: number
  rootIds: string[]
  scope: GatewayScope
  passwordChangedAt: string | null
  passwordRetrievable: boolean
}

export interface GatewayConnection {
  id: string
  accountId: string
  protocol: string
  peerAddress: string
  connectedAt: string
  lastActivityAt: string
}

export interface GatewayCredential {
  account: GatewayAccount
  password: string
  endpoints: GatewayEndpoint[]
}

interface AccountInput {
  name: string
  mode: GatewayMode
  disabled: boolean
  rootIds: string[]
  scope: GatewayScope
  password?: string
}

const accounts = '/ftp/accounts'
const route = (id: string) => accounts + '/' + encodeURIComponent(id)
export const readGatewayAccounts = (signal: AbortSignal) => readAll<GatewayAccount>(accounts, signal)
export const readGatewayAccount = (id: string, signal: AbortSignal) => request<GatewayAccount>(route(id), {signal})
export const readGatewayEndpoints = (signal: AbortSignal) => request<GatewayEndpoint[]>('/ftp/connection', {signal})
export const readGatewayConnections = (id: string | undefined, signal: AbortSignal) =>
  request<GatewayConnection[]>(query('/ftp/connections', {accountId: id}), {signal})

export function createGatewayAccount({name, mode, rootIds, scope, password}: AccountInput, signal: AbortSignal) {
  return send<GatewayCredential>(accounts, 'POST', {name, mode, rootIds, scope, password}, {signal})
}

export function updateGatewayAccount(account: GatewayAccount, {name, disabled, rootIds, scope}: AccountInput, signal: AbortSignal) {
  return send<GatewayAccount>(route(account.id), 'PUT', {name, disabled, rootIds, scope, revision: account.revision}, {signal})
}

export const removeGatewayAccount = (id: string, signal: AbortSignal) => send<void>(route(id), 'DELETE', undefined, {signal})
export const rotateGatewayPassword = (account: GatewayAccount, password: string | undefined, signal: AbortSignal) =>
  send<GatewayCredential>(route(account.id) + '/password', 'PUT', {revision: account.revision, password}, {signal})
export const revealGatewayPassword = (id: string, signal: AbortSignal) =>
  send<{name: string; password: string}>(route(id) + '/password/reveal', 'POST', undefined, {signal})

export function gatewayMode(mode: GatewayEndpoint['mode']): GatewayMode {
  return mode === 'plain' ? 'ftp' : mode === 'sftp' ? 'sftp' : 'ftps'
}

export function validGatewayPassword(value: string) {
  return !value || (/^[!-~]{16,128}$/.test(value) && new Set(value).size >= 8 &&
    /[A-Za-z]/.test(value) && /[^A-Za-z]/.test(value))
}
