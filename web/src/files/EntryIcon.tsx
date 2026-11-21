import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react'
import {FileDirectoryFillIcon, FileIcon, FileSymlinkFileIcon} from '@primer/octicons-react'
import {readFile} from '../api/fileReads'
import {thumbnail} from '../api/files'
import type {Entry} from '../api/types'
import {useResource} from '../ui/async'
import styles from './entryIcon.module.css'

const ThumbnailCache = createContext<Map<string, Blob> | null>(null)
const maxThumbnails = 128

export function ThumbnailProvider({children}: {children: ReactNode}) {
  const [cache] = useState(() => new Map<string, Blob>())
  return <ThumbnailCache.Provider value={cache}>{children}</ThumbnailCache.Provider>
}

export function useEntryThumbnail(device: string, rootId: string, entry?: Entry, enabled = true) {
  const cache = useContext(ThumbnailCache)
  const key = entry?.kind === 'file' && entry.thumbnail ? JSON.stringify([device, rootId, entry.path, entry.version]) : null
  const resource = useResource(enabled ? key : null, signal => {
    const cached = cache?.get(key!)
    if (cached) {
      cache?.delete(key!)
      cache?.set(key!, cached)
      return Promise.resolve(cached)
    }
    return readFile(device, 'thumbnail', signal, async () => {
      const known = cache?.get(key!)
      if (known) return known
      const blob = await thumbnail(device, rootId, entry!, signal)
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

export function EntryIcon({entry, url, detail = false}: {entry: Entry; url?: string; detail?: boolean}) {
  if (entry.kind === 'file' && entry.thumbnail) {
    const className = detail ? styles.largeFileIcon : styles.fileIcon
    return url ? <img src={url} className={className} alt="" draggable={false} /> : <span className={className} aria-hidden="true" />
  }
  const Icon = entry.kind === 'directory' ? FileDirectoryFillIcon : entry.kind === 'symlink' ? FileSymlinkFileIcon : FileIcon
  return <Icon className={entry.kind === 'directory' ? styles.folderIcon : undefined} size={detail ? 32 : 16} />
}

interface ListIconProps {device: string; rootId: string; entry: Entry; compact?: boolean}

function LazyFileIcon({device, rootId, entry, compact}: ListIconProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!anchor.current) return
    const observer = new IntersectionObserver(([item]) => setVisible(item.isIntersecting))
    observer.observe(anchor.current)
    return () => observer.disconnect()
  }, [])
  const {url} = useEntryThumbnail(device, rootId, entry, visible)
  return <span className={styles.entryThumbnail} data-compact={compact} ref={anchor}><EntryIcon entry={entry} url={url} /></span>
}

export function ListEntryIcon(props: ListIconProps) {
  return props.entry.kind === 'file' && props.entry.thumbnail ? <LazyFileIcon {...props} /> : <EntryIcon entry={props.entry} />
}
