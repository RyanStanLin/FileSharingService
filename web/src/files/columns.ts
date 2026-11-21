import type {Entry, SortKey} from '../api/types'
import {bytes, date, entryKind} from '../i18n/format'
import type {Locale, Message, Translate} from '../i18n'

export const optionalColumns = [
  {key: 'modifiedAt', label: 'dateModified'},
  {key: 'createdAt', label: 'dateAdded'},
  {key: 'type', label: 'kind'},
  {key: 'size', label: 'size'},
  {key: 'lastOpenedAt', label: 'lastOpened'},
] as const satisfies ReadonlyArray<{key: SortKey; label: Message}>

export type ColumnKey = (typeof optionalColumns)[number]['key']
export const defaultColumns: ColumnKey[] = ['modifiedAt', 'createdAt', 'type']

export function valueFor(entry: Entry, key: ColumnKey, locale: Locale, t: Translate) {
  if (key === 'type') return entryKind(entry, t)
  if (key === 'size') return entry.kind === 'directory' ? t('missing') : bytes(entry.size, locale)
  return date(entry[key], locale)
}
