import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react'
import {readFile} from '../api/fileReads'
import {useResource} from './async'

const ThumbnailCache = createContext<Map<string, Blob> | null>(null)
const maxThumbnails = 128

export function ThumbnailProvider({children}: {children: ReactNode}) {
  const [cache] = useState(() => new Map<string, Blob>())
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
      cache?.set(key!, blob)
      if (cache && cache.size > maxThumbnails) cache.delete(cache.keys().next().value!)
      return blob
    })
  })
  const blob = resource.data
  const [image, setImage] = useState<{blob: Blob; url: string}>()
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setImage({blob, url})
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return {url: image && image.blob === blob ? image.url : undefined, pending: resource.pending}
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
