import type {SortKey} from '../api/types'
import type {Message} from '../i18n'

export const optionalColumns = [
  {key: 'modifiedAt', label: 'dateModified'},
  {key: 'createdAt', label: 'dateAdded'},
  {key: 'type', label: 'kind'},
  {key: 'size', label: 'size'},
  {key: 'lastOpenedAt', label: 'lastOpened'},
] as const satisfies ReadonlyArray<{key: SortKey; label: Message}>

export type ColumnKey = (typeof optionalColumns)[number]['key']
export const defaultColumns: ColumnKey[] = ['modifiedAt', 'createdAt', 'type']
