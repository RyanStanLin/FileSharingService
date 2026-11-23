import {ApiError, wait} from '../api/client'
import {browse, stat} from '../api/files'
import type {DirectoryPage, Entry, Location, Share} from '../api/types'
import {homeLocation, locationOf, parent} from './navigation'

export interface PathContext {
  shares: Share[]
  location: Location
  roots: ReadonlyMap<string, string>
}

export interface PathSuggestion {
  text: string
  target: Location
  hidden?: boolean
}

interface CachedFolder {
  page: DirectoryPage
  items: Entry[]
}

export type PathCache = Map<string, CachedFolder>
const suggestionLimit = 8
const caseFold = (value: string) => value.normalize('NFC').toLowerCase()

function components(value: string, initial: string[] = []) {
  if (/[\\\u0000-\u001f\u007f]/.test(value)) throw new ApiError(400, 'invalid_path')
  const parts = [...initial]
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) throw new ApiError(403, 'path_not_shared')
      parts.pop()
    } else parts.push(part)
  }
  return parts
}

export function resolvePath(value: string, {shares, location, roots}: PathContext): Location {
  if (value.startsWith('/')) {
    const parts = components(value)
    const candidates = Array.from(roots, ([rootId, path]) => ({rootId, parts: components(path)}))
      .sort((a, b) => b.parts.length - a.parts.length)
    const root = candidates.find(candidate => candidate.parts.every((part, index) =>
      index < parts.length && caseFold(part) === caseFold(parts[index])))
    if (!root) throw new ApiError(403, 'path_not_shared')
    return {rootId: root.rootId, path: parts.slice(root.parts.length).join('/'), kind: 'folder'}
  }

  if (value === '~' || value.startsWith('~/')) {
    const home = shares.find(share => share.primary)
    if (!home) throw new ApiError(403, 'path_not_shared')
    return {...homeLocation(home), path: components(value.slice(1)).join('/')}
  }

  const base = location.kind === 'folder' ? location.path : parent(location.path)
  return {...location, path: components(value, components(base)).join('/'), kind: 'folder'}
}

export async function readSharedPaths(device: string, shares: Share[], known: {id: string; path?: string}, signal: AbortSignal) {
  const records = await Promise.all(shares.map(async share => {
    if (share.id === known.id && known.path) return [share.id, known.path] as const
    try {
      const entry = await stat(device, homeLocation(share), signal, false, 'background')
      return [share.id, entry.fullPath] as const
    } catch {
      signal.throwIfAborted()
      return null
    }
  }))
  return new Map(records.filter(record => record !== null))
}

function rootSuggestions(value: string, context: PathContext): PathSuggestion[] {
  const prefix = caseFold(value)
  return [...context.roots].filter(([, absolute]) => caseFold(absolute).startsWith(prefix))
    .slice(0, suggestionLimit).map(([rootId, absolute]) => ({
      text: absolute.endsWith('/') ? absolute : absolute + '/',
      target: {rootId, path: '', kind: 'folder'},
    }))
}

async function readMatches(device: string, target: Location, prefix: string, showHidden: boolean, cache: PathCache, signal: AbortSignal) {
  const listing = {hidden: showHidden || prefix.startsWith('.'), sort: 'name', direction: 'asc', limit: 200} as const
  const key = JSON.stringify([target.rootId, target.path, listing.hidden])
  const typed = caseFold(prefix)
  let cached = cache.get(key)
  let matches = cached?.items.filter(entry => caseFold(entry.name).startsWith(typed)) ?? []
  if (matches.length || cached?.page.nextOffset === null) return matches.slice(0, suggestionLimit)

  try {
    do {
      const page = await browse(device, target, listing, signal, cached?.page, 'background')
      const items = cached?.items ?? []
      items.push(...page.items)
      cached = {page, items}
      cache.set(key, cached)
      if (cache.size > 4) cache.delete(cache.keys().next().value!)
      matches = page.items.filter(entry => caseFold(entry.name).startsWith(typed))
    } while (!matches.length && cached.page.nextOffset !== null)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'snapshot_changed') cache.delete(key)
    throw error
  }
  return matches.slice(0, suggestionLimit)
}

export async function suggestPaths(device: string, value: string, context: PathContext, hidden: boolean, cache: PathCache, signal: AbortSignal) {
  await wait(220, signal)
  if (value === '~') {
    const home = context.shares.find(share => share.primary)
    return home ? [{text: '~/', target: homeLocation(home)}] : []
  }
  const slash = value.lastIndexOf('/') + 1
  const stem = value.slice(0, slash)
  const prefix = value.slice(slash)
  let target: Location
  try {
    target = resolvePath(stem, context)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'path_not_shared' && value.startsWith('/')) {
      return rootSuggestions(value, context)
    }
    return []
  }
  try {
    const entries = await readMatches(device, target, prefix, hidden, cache, signal)
    return entries.map(entry => ({
      text: stem + entry.name + (entry.kind === 'directory' ? '/' : ''),
      target: locationOf(target.rootId, entry),
      hidden: entry.hidden,
    }))
  } catch (error) {
    if (error instanceof ApiError && ['not_found', 'not_directory', 'invalid_path', 'permission_denied',
      'filesystem_access_denied', 'snapshot_changed'].includes(error.code)) return []
    throw error
  }
}
