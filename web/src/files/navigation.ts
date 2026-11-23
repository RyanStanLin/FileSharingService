import {useSyncExternalStore} from 'react'
import type {Entry, Location, PermissionKind, Share} from '../api/types'

export const homeLocation = (share: Share): Location => ({rootId: share.id, path: '', kind: 'folder'})
export const join = (path: string, name: string) => path ? path + '/' + name : name
export const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const locationOf = (rootId: string, entry: Entry): Location =>
  ({rootId, path: entry.path, kind: entry.kind === 'directory' ? 'folder' : 'file'})

export function href(location: Location) {
  return '#' + new URLSearchParams({root: location.rootId, path: location.path, view: location.kind})
}

export function navigate(location: Location) {
  const target = href(location)
  if (window.location.hash !== target) window.location.hash = target
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export function useLocation(shares: Share[]) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const parameters = new URLSearchParams(hash.slice(1))
  const root = shares.find(share => share.id === parameters.get('root')) ?? shares[0]
  const location: Location | undefined = root && (root.id === parameters.get('root')
    ? {rootId: root.id, path: parameters.get('path') ?? '', kind: parameters.get('view') === 'file' ? 'file' : 'folder'}
    : homeLocation(root))
  return {root, location}
}

export function permissionFor(share: Share, path: string): PermissionKind | undefined {
  if (!share.primary) return
  switch (path.split('/')[0]) {
    case 'Downloads': return 'downloads'
    case 'Documents': return 'documents'
    case 'Desktop': return 'desktop'
  }
}

export function canWriteFolder(share: Share, path: string) {
  const top = path.split('/')[0].toLowerCase()
  if (share.primary && (top === 'library' || top === 'applications')) return false
  const permission = permissionFor(share, path)
  return share.writable || !!(permission && share.writableFolders?.includes(permission))
}

export function canWriteEntry(share: Share, path: string) {
  if (share.primary && !path.includes('/') &&
      ['library', 'desktop', 'downloads', 'documents', 'music', 'pictures', 'movies', 'applications', 'public'].includes(path.toLowerCase())) return false
  return canWriteFolder(share, parent(path))
}
