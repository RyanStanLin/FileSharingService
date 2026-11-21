import type {Entry} from '../api/types'

export type FileAction =
  | {kind: 'mkdir' | 'upload'}
  | {kind: 'info'; entry?: Entry}
  | {kind: 'rename' | 'move' | 'trash' | 'remove'; entry: Entry}

export type OpenAction = (action: FileAction) => void
export type DownloadSelection = (entries: Entry[] | ((signal: AbortSignal) => Promise<Entry[]>)) => void
