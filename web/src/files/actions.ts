import type {Entry, Location, Share} from '../api/types'

export type FileAction =
  | {kind: 'mkdir'; folder?: Entry}
  | {kind: 'upload'; folder?: Entry}
  | {kind: 'info'; entry?: Entry}
  | {kind: 'rename'; entry: Entry}
  | {kind: 'move'; entry: Entry}
  | {kind: 'trash'; entry: Entry}
  | {kind: 'remove'; entry: Entry}

export interface FileDialogProps<Action extends FileAction = FileAction> {
  action: Action
  deviceId: string
  share: Share
  location: Location
  hidden: boolean
  roots: Share[]
  directoryEntries: Entry[]
  close: () => void
  changed: (entry?: Entry) => void
  refresh: () => void
}

export type OpenAction = (action: FileAction) => void
export type DownloadSelection = (entries: Entry[] | ((signal: AbortSignal) => Promise<Entry[]>)) => void
