import {ApiError, request, response, send, wait} from './client'
import type {Entry, Location, Transfer} from './types'

const chunkBytes = 262_144

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

function start(input: TransferInput, signal: AbortSignal) {
  const headers = {'Idempotency-Key': crypto.randomUUID()}
  return retryNetwork(() => send<Transfer>('/transfers', 'POST', input, {headers, signal}), signal)
}

export async function upload(
  deviceId: string, rootId: string, path: string, file: File,
  progress: (fraction: number) => void, signal: AbortSignal,
) {
  const transfer = await start({deviceId, rootId, kind: 'upload', path, length: file.size}, signal)
  const route = '/transfers/' + transfer.id
  try {
    let offset = transfer.offset
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + chunkBytes)
      const result = await retryNetwork(() => response(route + '/content', {
        method: 'PUT', body: chunk, signal,
        headers: {'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset)},
      }), signal)
      const next = Number(result.headers.get('Upload-Offset'))
      if (!Number.isSafeInteger(next) || next !== offset + chunk.size) throw new ApiError(409, 'invalid_offset')
      offset = next
      progress(offset / file.size)
    }
    return await retryNetwork(() => send<Entry>(route + '/commit', 'POST', undefined, {signal}), signal)
  } catch (error) {
    void request(route, {method: 'DELETE', keepalive: true}).catch(() => undefined)
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
