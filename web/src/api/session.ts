import {ApiError, request, send} from './client'
import type {AuthStatus, Session} from './types'

interface Challenge<Options> {
  challengeId: string
  publicKey: Options
}

export const status = (signal?: AbortSignal) => request<AuthStatus>('/auth/status', {signal, anonymous: true})
export const lock = () => send<void>('/auth/lock', 'POST', undefined, {anonymous: true})

function webAuthn() {
  if (!window.isSecureContext || !window.PublicKeyCredential?.parseRequestOptionsFromJSON ||
      !window.PublicKeyCredential?.parseCreationOptionsFromJSON) {
    throw new ApiError(0, 'passkey_unsupported')
  }
}

export async function unlock(signal: AbortSignal) {
  webAuthn()
  const route = '/auth/passkeys/authentication'
  const options = {anonymous: true, signal}
  const {challengeId, publicKey} = await send<Challenge<PublicKeyCredentialRequestOptionsJSON>>(
    route + '/options', 'POST', undefined, options,
  )
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey), signal,
  })
  if (!(credential instanceof PublicKeyCredential)) throw new ApiError(0, 'passkey_cancelled')
  return send<Session>(route, 'POST', {challengeId, credential: credential.toJSON()}, options)
}

export async function register(secret: string, signal: AbortSignal) {
  webAuthn()
  const route = '/auth/passkeys/registration'
  const options = {anonymous: true, signal}
  const {challengeId, publicKey} = await send<Challenge<PublicKeyCredentialCreationOptionsJSON>>(
    route + '/options', 'POST', {secret}, options,
  )
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey), signal,
  })
  if (!(credential instanceof PublicKeyCredential)) throw new ApiError(0, 'passkey_cancelled')
  await send<void>(route, 'POST', {challengeId, secret, credential: credential.toJSON()}, options)
}
