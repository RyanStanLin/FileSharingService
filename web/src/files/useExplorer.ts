import {useState} from 'react'
import type {Direction} from '../api/files'
import type {Location, SortKey} from '../api/types'
import {defaultColumns, optionalColumns, type ColumnKey} from './columns'
import {useDirectory} from './useDirectory'

const columnPreference = 'filesharing.columns'

function initialColumns() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(columnPreference) ?? 'null')
    if (Array.isArray(saved)) return optionalColumns.map(column => column.key).filter(key => saved.includes(key))
  } catch { return defaultColumns }
  return defaultColumns
}

export function useExplorer(deviceId: string, location: Location | undefined, hidden: boolean) {
  const [visible, setVisible] = useState<ColumnKey[]>(initialColumns)
  const [sort, setSort] = useState<SortKey>(visible.includes('createdAt') ? 'createdAt' : 'name')
  const [direction, setDirection] = useState<Direction>('asc')
  const listing = {hidden, sort, direction}
  const view = useDirectory(deviceId, location, listing)

  function toggleColumn(column: ColumnKey) {
    const next = visible.includes(column) ? visible.filter(item => item !== column) : [...visible, column]
    if (sort === column && !next.includes(column)) {
      setSort('name')
      setDirection('asc')
    }
    setVisible(next)
    localStorage.setItem(columnPreference, JSON.stringify(next))
  }

  function changeSort(next: SortKey, order: Direction) {
    setSort(next)
    setDirection(order)
  }

  return {view, visible, sort, direction, listing, toggleColumn, changeSort}
}

export type Explorer = ReturnType<typeof useExplorer>
