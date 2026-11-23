import type {Entry, Location, Share} from '../api/types'

export type FileAction =
  | {kind: 'mkdir'; folder?: Entry}
  | {kind: 'upload'; folder?: Entry}
  | {kind: 'info'; entry?: Entry}
  | {kind: 'rename'; entry: Entry}
  | {kind: 'trash'; entry: Entry}
  | {kind: 'remove'; entry: Entry}

export interface FileDialogProps<Action extends FileAction = FileAction> {
  action: Action
  deviceId: string
  share: Share
  location: Location
  directoryEntries: Entry[]
  close: () => void
  changed: (entry?: Entry) => void
  refresh: () => void
}

export type OpenAction = (action: FileAction) => void
export type EntrySource = Entry[] | ((signal: AbortSignal) => Promise<Entry[]>)
export type DownloadSelection = (entries: EntrySource) => void
