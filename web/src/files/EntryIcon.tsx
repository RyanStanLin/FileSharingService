import {FileDirectoryFillIcon, FileIcon, FileSymlinkFileIcon} from '@primer/octicons-react'
import {thumbnail} from '../api/files'
import type {Entry} from '../api/types'
import {useThumbnail, useThumbnailVisibility} from '../ui/thumbnails'
import sharedStyles from '../ui/thumbnail.module.css'
import styles from './entryIcon.module.css'

export function useEntryThumbnail(device: string, rootId: string, entry?: Entry, enabled = true) {
  const key = enabled && entry?.kind === 'file' && entry.thumbnail ? JSON.stringify([device, rootId, entry.path, entry.version]) : null
  return useThumbnail(device, key, signal => thumbnail(device, rootId, entry!, signal))
}

export function EntryIcon({entry, url, detail = false}: {entry: Entry; url?: string; detail?: boolean}) {
  if (entry.kind === 'file' && entry.thumbnail) {
    const className = detail ? styles.largeFileIcon : sharedStyles.image
    return url ? <img src={url} className={className} alt="" draggable={false} /> : <span className={className} aria-hidden="true" />
  }
  const Icon = entry.kind === 'directory' ? FileDirectoryFillIcon : entry.kind === 'symlink' ? FileSymlinkFileIcon : FileIcon
  return <Icon className={entry.kind === 'directory' ? styles.folderIcon : undefined} size={detail ? 32 : 16} />
}

interface ListIconProps {device: string; rootId: string; entry: Entry; compact?: boolean}

function LazyFileIcon({device, rootId, entry, compact}: ListIconProps) {
  const {anchor, visible} = useThumbnailVisibility()
  const {url} = useEntryThumbnail(device, rootId, entry, visible)
  return <span className={sharedStyles.frame} data-compact={compact} ref={anchor}><EntryIcon entry={entry} url={url} /></span>
}

export function ListEntryIcon(props: ListIconProps) {
  return props.entry.kind === 'file' && props.entry.thumbnail ? <LazyFileIcon {...props} /> : <EntryIcon entry={props.entry} />
}
