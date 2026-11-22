import {ApiError, request, response, send, wait} from './client'
import type {Entry, Location, Transfer} from './types'

const chunkBytes = 262_144
export const uploadLimitBytes = 64 * 1024 ** 3

export type UploadProgress = {phase: 'preparing' | 'uploading' | 'committing'; fraction: number}

interface TransferInput {
  deviceId: string
  rootId: string
  kind: 'archive' | 'download' | 'upload'
  path?: string
  length?: number
  entries?: string[]
  version?: string
}

async function retryNetwork<T>(work: () => Promise<T>, signal: AbortSignal) {
  try {
    return await work()
  } catch (error) {
    if (!(error instanceof TypeError) || signal.aborted) throw error
    await wait(400, signal)
    return work()
  }
}

function start(input: TransferInput, signal: AbortSignal, retry = retryNetwork) {
  const headers = {'Idempotency-Key': crypto.randomUUID()}
  return retry(() => send<Transfer>('/transfers', 'POST', input, {headers, signal}), signal)
}

async function retryUpload<T>(work: () => Promise<T>, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      signal.throwIfAborted()
      const transient = error instanceof TypeError || error instanceof ApiError &&
        ([429, 502, 504].includes(error.status) || error.code === 'device_timeout')
      const retryAfter = error instanceof ApiError ? error.retryAfterMs ?? 0 : 0
      if (!transient || attempt >= 2 || retryAfter > 8000) throw error
      await wait(Math.max(500 * 2 ** attempt, retryAfter), signal)
    }
  }
}

export async function upload(
  deviceId: string, rootId: string, path: string, file: File,
  version: string | undefined, progress: (value: UploadProgress) => void, signal: AbortSignal,
) {
  const transfer = await start({deviceId, rootId, kind: 'upload', path, length: file.size, version}, signal, retryUpload)
  const route = '/transfers/' + transfer.id
  try {
    let offset = transfer.offset
    if (transfer.state !== 'ready') throw new ApiError(409, transfer.error ?? 'transfer_not_writable')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new ApiError(409, 'invalid_offset')
    while (offset < file.size) {
      const chunk = await file.slice(offset, offset + chunkBytes).arrayBuffer().catch(() => {
        throw new ApiError(422, 'upload_source_unreadable')
      })
      signal.throwIfAborted()
      if (chunk.byteLength !== Math.min(chunkBytes, file.size - offset)) throw new ApiError(422, 'upload_source_unreadable')
      const result = await retryUpload(() => response(route + '/content', {
        method: 'PUT', body: chunk, signal,
        headers: {'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset)},
      }), signal)
      const next = Number(result.headers.get('Upload-Offset'))
      if (!Number.isSafeInteger(next) || next !== offset + chunk.byteLength) throw new ApiError(409, 'invalid_offset')
      offset = next
      progress({phase: 'uploading', fraction: offset / file.size})
    }
    progress({phase: 'committing', fraction: 1})
    return await retryUpload(() => send<Entry>(route + '/commit', 'POST', undefined, {signal}), signal)
  } catch (error) {
    void request(route, {method: 'DELETE', keepalive: true}).catch(() => undefined)
    if (error instanceof ApiError && error.code === 'limit_reached') throw new ApiError(error.status, 'upload_limit_reached')
    throw error
  }
}

async function prepareDownload(input: TransferInput, signal: AbortSignal) {
  let transfer = await start(input, signal)
  while (transfer.state === 'preparing') {
    await wait(800, signal)
    transfer = await request<Transfer>('/transfers/' + transfer.id, {signal})
  }
  if (transfer.downloadUrl !== '/api/v1/transfers/' + transfer.id + '/content') {
    throw new ApiError(409, transfer.error ?? 'download_unavailable')
  }
  return {url: transfer.downloadUrl, name: transfer.fileName}
}

export function prepareFileDownload(deviceId: string, rootId: string, entry: Entry, signal: AbortSignal) {
  return prepareDownload({deviceId, rootId, kind: 'download', path: entry.path, version: entry.version}, signal)
}

export async function download(deviceId: string, location: Location, entries: Entry[], signal: AbortSignal) {
  const entry = entries.length === 1 ? entries[0] : undefined
  const {rootId, path} = location
  const source = entry?.kind === 'file'
    ? await prepareFileDownload(deviceId, rootId, entry, signal)
    : await prepareDownload({deviceId, rootId, kind: 'archive',
      ...(entries.length ? {entries: entries.map(item => item.path)} : {path})}, signal)
  const link = document.createElement('a')
  link.href = source.url
  link.download = source.name
  document.body.append(link)
  link.click()
  link.remove()
}
