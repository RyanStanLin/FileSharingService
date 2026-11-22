import type {ReactNode} from 'react'
import type {DataObject, DataValue, Snapshot} from '../api/telemetry'
import type {Locale, Translate} from '../i18n'
import {fieldLabel} from './dataFields'
import {displayField, object} from './format'

export interface ReadingCell {
  text: string
  order?: string | number | null
  label?: boolean
}

export interface ReadingRow {
  id: string
  name: ReadingCell
  values: Record<string, ReadingCell>
  icon?: ReactNode
  value?: DataObject
}

export interface ReadingColumn {
  key: string
  title: string
}

export interface ReadingDataset {
  key: string
  title: string
  nameTitle: string
  description?: string
  columns: ReadingColumn[]
  rows: ReadingRow[]
  snapshot?: Pick<Snapshot, 'observedAt' | 'stale'>
  icons?: boolean
  details?: boolean
  sort?: {key: string; direction: 'asc' | 'desc'}
  empty?: string
  pending?: boolean
}

export function cell(text: string, order?: ReadingCell['order'], label?: boolean): ReadingCell {
  return {text, order, label}
}

export function valueCell(field: string, value: DataValue | undefined, locale: Locale, t: Translate, label?: boolean) {
  let order = typeof value === 'boolean' ? Number(value) : typeof value === 'number' || typeof value === 'string' ? value : null
  if (typeof value === 'string' && field.endsWith('At')) {
    const epoch = Date.parse(value)
    order = Number.isFinite(epoch) ? epoch : null
  }
  return cell(displayField(field, value, locale, t), order, label)
}

export function fieldColumns(labels: readonly string[], locale: Locale) {
  return labels.map(key => ({key, title: fieldLabel(key, locale)}))
}

export function fieldRows(value: DataObject | undefined, locale: Locale, t: Translate): ReadingRow[] {
  const rows: ReadingRow[] = []
  function append(field: string, entry: DataValue, path: string[], labels: string[], parent?: string) {
    const id = [...path, field]
    const name = [...labels, fieldLabel(field, locale)]
    const nested = object(entry)
    if (nested && Object.keys(nested).length) {
      for (const [key, item] of Object.entries(nested)) append(key, item, id, name, field)
      return
    }
    if (Array.isArray(entry) && entry.some(item => item !== null && typeof item === 'object')) {
      entry.forEach((item, index) => append(String(index + 1), item, id, name, field))
      return
    }
    const shown = Array.isArray(entry)
      ? cell(entry.length ? new Intl.ListFormat(locale).format(entry.map(item => displayField(field, item, locale, t, parent))) : t('dataEmptyList'))
      : cell(nested ? t('dataEmptyList') : displayField(field, entry, locale, t, parent))
    rows.push({id: JSON.stringify(id), name: cell(name.join(' / ')), values: {value: shown}})
  }
  for (const [field, entry] of Object.entries(value ?? {})) append(field, entry, [], [])
  return rows
}

export function objectDataset(key: string, title: string, value: DataObject | undefined, locale: Locale, t: Translate,
  snapshot?: ReadingDataset['snapshot']): ReadingDataset {
  return {key, title, nameTitle: t('dataField'), columns: [{key: 'value', title: t('dataValue')}],
    rows: fieldRows(value, locale, t), snapshot}
}

export function sortRows(rows: ReadingRow[], key: string, direction: 'asc' | 'desc', collator: Intl.Collator) {
  function sortValue(row: ReadingRow) {
    const field = key === 'name' ? row.name : row.values[key]
    return field?.order === undefined ? field?.text : field.order
  }
  return [...rows].sort((left, right) => {
    const a = sortValue(left)
    const b = sortValue(right)
    if (a == null || b == null) return Number(a == null) - Number(b == null)
    const comparison = typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))
    return direction === 'asc' ? comparison : -comparison
  })
}
