export interface Session {
  id: string
  createdAt: string
  expiresAt: string
}

export interface AuthStatus {
  initialized: boolean
  unlocked: boolean
  session: Session | null
}

export interface Connection {
  online: boolean
  connectionId: string | null
  accessGranted: boolean
  connectedAt: string | null
  connectionSeconds: number | null
}

export interface Device {
  id: string
  name: string
  connection: Connection
}

export interface Root {
  id: string
  rootKey: string
  label: string
  writable: boolean
  enabled: boolean
  revision: number
}

export interface LocalRoot {
  rootKey: string
  label: string
  writable: boolean
  primary: boolean
}

export interface Share extends Root {
  primary: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface DirectorySummary {
  folderSize: number
  filesCount: number
  foldersCount: number
  complete: boolean
}

export interface Entry {
  name: string
  path: string
  fullPath: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  createdAt: string | null
  modifiedAt: string | null
  lastOpenedAt: string | null
  lastAccessedAt: string | null
  fileType: string | null
  extension: string | null
  owner: number
  mode: number
  version: string
  hidden: boolean
  thumbnail: 'image' | 'pdf' | 'file' | 'folder' | null
  folder: DirectorySummary | null
}

export interface Location {
  rootId: string
  path: string
  kind: 'folder' | 'file'
}

export type SortKey = 'name' | 'size' | 'createdAt' | 'modifiedAt' | 'type' | 'lastOpenedAt'

export interface DirectoryPage {
  revision: string
  snapshotRevision: string
  items: Entry[]
  nextOffset: number | null
  total: number
}

export type PermissionKind = 'downloads' | 'documents' | 'desktop'
export type PermissionState = 'notDetermined' | 'allowed' | 'denied' | 'requiresSystemSettings' | 'unavailable' | 'unknown'

export interface Permission {
  state: PermissionState
  phase: 'idle' | 'requesting' | 'completed'
}

export type Permissions = Partial<Record<PermissionKind, Permission>>

export interface Transfer {
  id: string
  state: string
  path: string
  fileName: string
  length: number
  offset: number
  error: string | null
  downloadUrl: string | null
}
