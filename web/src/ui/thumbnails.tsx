import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react'
import {readFile} from '../api/fileReads'
import {useResource} from './async'

const ThumbnailCache = createContext<Map<string, string> | null>(null)
const maxThumbnails = 128

function readThumbnailUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(reader.error ?? new Error('Could not read the thumbnail'))
    }
    reader.readAsDataURL(blob)
  })
}

export function ThumbnailProvider({children}: {children: ReactNode}) {
  const [cache] = useState(() => new Map<string, string>())
  return <ThumbnailCache.Provider value={cache}>{children}</ThumbnailCache.Provider>
}

export function useThumbnail(device: string, key: string | null, load: (signal: AbortSignal) => Promise<Blob>) {
  const cache = useContext(ThumbnailCache)
  const resource = useResource(key, signal => {
    const cached = cache?.get(key!)
    if (cached) {
      cache?.delete(key!)
      cache?.set(key!, cached)
      return Promise.resolve(cached)
    }
    return readFile(device, 'thumbnail', signal, async () => {
      const known = cache?.get(key!)
      if (known) return known
      const blob = await load(signal)
      signal.throwIfAborted()
      const url = await readThumbnailUrl(blob)
      signal.throwIfAborted()
      cache?.set(key!, url)
      if (cache && cache.size > maxThumbnails) cache.delete(cache.keys().next().value!)
      return url
    })
  })
  return {url: resource.data, pending: resource.pending}
}

export function useThumbnailVisibility() {
  const anchor = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!anchor.current) return
    const observer = new IntersectionObserver(([item]) => setVisible(item.isIntersecting))
    observer.observe(anchor.current)
    return () => observer.disconnect()
  }, [])
  return {anchor, visible}
}
