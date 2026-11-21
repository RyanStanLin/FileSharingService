import {apiPrefix, query, request, send} from './client'
import {deviceRoute} from './devices'
import type {DirectoryPage, Entry, Location, SortKey} from './types'

export type Direction = 'asc' | 'desc'
export interface Listing {
  hidden: boolean
  sort: SortKey
  direction: Direction
  limit?: number
}

const fileRoute = (device: string) => deviceRoute(device) + '/files'

export function browse(device: string, location: Location, listing: Listing, signal: AbortSignal, page?: DirectoryPage) {
  const {rootId, path} = location
  return request<DirectoryPage>(query(fileRoute(device) + '/entries', {
    rootId, path, limit: 80, ...listing, offset: page?.nextOffset, revision: page?.revision,
  }), {signal})
}

export function stat(device: string, location: Location, signal: AbortSignal, summary = true) {
  const {rootId, path} = location
  return request<Entry>(query(fileRoute(device) + '/entry', {rootId, path, summary}), {signal})
}

export function thumbnail(device: string, rootId: string, entry: Entry) {
  return apiPrefix + query(fileRoute(device) + '/thumbnail', {rootId, path: entry.path, version: entry.version})
}

export function mkdir(device: string, location: Location, path: string, signal: AbortSignal) {
  return send<Entry>(fileRoute(device) + '/directories', 'POST', {rootId: location.rootId, path}, {signal})
}

function reference(location: Location, entry: Entry) {
  return {rootId: location.rootId, path: entry.path, version: entry.version}
}

export function rename(device: string, location: Location, entry: Entry, newName: string, signal: AbortSignal) {
  return send<Entry>(fileRoute(device) + '/renames', 'POST', {...reference(location, entry), newName}, {signal})
}

export function move(device: string, location: Location, entry: Entry, destination: string, destinationRootId: string, signal: AbortSignal) {
  return send<Entry>(fileRoute(device) + '/moves', 'POST',
    {...reference(location, entry), destination, destinationRootId}, {signal})
}

export function trash(device: string, location: Location, entry: Entry, signal: AbortSignal) {
  return send<void>(fileRoute(device) + '/trash', 'POST', reference(location, entry), {signal})
}

export function remove(device: string, location: Location, entry: Entry, recursive: boolean, signal: AbortSignal) {
  return request<void>(query(fileRoute(device) + '/entry', {...reference(location, entry), recursive}), {method: 'DELETE', signal})
}
