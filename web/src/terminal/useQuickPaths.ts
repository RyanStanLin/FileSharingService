import {useState} from 'react'
import {ApiError} from '../api/client'
import {readShares} from '../api/devices'
import {stat} from '../api/files'
import {readSharedPaths, resolvePath, suggestPaths, type PathCache, type PathContext} from '../files/goToPaths'
import {homeLocation, locationOf} from '../files/navigation'
import {useResource} from '../ui/async'

export const isQuickPath = (value: string) => /^(?:\/|~(?:\/|$)|\.{1,2}(?:\/|$))/.test(value)
  || /^[^\s/>]+[/]/.test(value)

function fromRoot(context: PathContext) {
  const share = context.shares.find(share => share.id === context.location.rootId)
  return share ? {...context, location: homeLocation(share)} : context
}

function resolveQuick(value: string, context: PathContext) {
  try { return resolvePath(value, context) } catch (error) {
    if (!value.startsWith('/') || !(error instanceof ApiError) || error.code !== 'path_not_shared') throw error
    return resolvePath(value.slice(1), fromRoot(context))
  }
}

export function useQuickPaths(deviceId: string, hash: string, path: string, enabled: boolean) {
  const [lookedUp, setLookedUp] = useState(false)
  const [cache] = useState<PathCache>(() => new Map())
  const shares = useResource(lookedUp && enabled ? deviceId : null, signal => readShares(deviceId, signal))
  const sharing = shares.data?.shares ?? []
  const params = new URLSearchParams(hash.slice(1))
  const root = sharing.find(share => share.id === params.get('root')) ?? sharing.find(share => share.primary) ?? sharing[0]
  const base = root && (root.id === params.get('root') ? {...homeLocation(root), path: params.get('path') ?? '',
    kind: params.get('view') === 'file' ? 'file' as const : 'folder' as const} : homeLocation(root))
  const roots = useResource(path.startsWith('/') && base && shares.data ? `${deviceId}:${root?.id}` : null,
    signal => readSharedPaths(deviceId, sharing, {id: ''}, signal))
  const scope = base && {shares: sharing, location: base, roots: roots.data ?? new Map<string, string>()}
  const maySuggest = scope && path.length > 0 && (!path.startsWith('/') || roots.data)
  const suggestions = useResource(maySuggest ? `${deviceId}:${path}` : null, async signal => {
    const found = await suggestPaths(deviceId, path, scope!, false, cache, signal)
    if (found.length || !path.startsWith('/')) return found
    const prefix = path.slice(1)
    const relative = await suggestPaths(deviceId, prefix || './', fromRoot(scope!), false, cache, signal)
    return relative.map(suggestion => ({...suggestion, text: '/' + suggestion.text.replace(/^\.\//, '')}))
  })

  return {
    start: () => setLookedUp(true),
    suggestions: suggestions.data ?? [],
    pending: !!path && (shares.pending || roots.pending || suggestions.pending),
    error: suggestions.error ?? roots.error ?? shares.error,
    async location(value: string, signal: AbortSignal) {
      if (!scope) throw shares.error ?? new ApiError(403, 'path_not_shared')
      const ready = value.startsWith('/') && !roots.data
        ? {...scope, roots: await readSharedPaths(deviceId, sharing, {id: ''}, signal)} : scope
      const target = resolveQuick(value, ready)
      const entry = await stat(deviceId, target, signal)
      if (value.endsWith('/') && entry.kind !== 'directory') throw new ApiError(400, 'invalid_path')
      return locationOf(target.rootId, entry)
    },
  }
}
