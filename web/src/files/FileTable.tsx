import {Checkbox, Label, Link} from '@primer/react'
import {DataTable, type DataTableProps} from '@primer/react/experimental'
import type {Direction} from '../api/files'
import type {Entry, Location, Share, SortKey} from '../api/types'
import {useLanguage} from '../i18n'
import type {OpenAction} from './actions'
import {optionalColumns, valueFor, type ColumnKey} from './columns'
import {EntryMenu} from './EntryMenu'
import {EntryIcon} from './Metadata'
import {href, locationOf} from './navigation'
import styles from './table.module.css'

interface Row extends Entry {
  id: string
}

interface Props {
  titleId: string
  location: Location
  share: Share
  entries: Entry[]
  selected: ReadonlySet<string>
  setSelected: (selection: Set<string>) => void
  visible: ColumnKey[]
  sort: SortKey
  direction: Direction
  onSort: (sort: SortKey, direction: Direction) => void
  onAction: OpenAction
  onDownload: (entries: Entry[]) => void
}

export function FileTable(props: Props) {
  const {t, locale} = useLanguage()
  const {entries, selected, setSelected, visible, location, share, onAction, onDownload} = props
  const all = entries.length > 0 && entries.every(entry => selected.has(entry.path))
  const some = entries.some(entry => selected.has(entry.path))

  const columns: DataTableProps<Row>['columns'] = [
    {
      id: 'selection', width: 'var(--base-size-32)',
      header: () => (
        <Checkbox aria-label={t('selectAll')} checked={all} indeterminate={some && !all} disabled={!entries.length}
          onChange={event => setSelected(new Set(event.target.checked ? entries.map(entry => entry.path) : []))} />
      ),
      renderCell: entry => (
        <Checkbox aria-label={t('selectEntry', {name: entry.name})} checked={selected.has(entry.path)}
          onChange={event => {
            const next = new Set(selected)
            if (event.target.checked) next.add(entry.path)
            else next.delete(entry.path)
            setSelected(next)
          }} />
      ),
    },
    {id: 'thumbnail', width: 'var(--base-size-36)', header: '', renderCell: entry => <EntryIcon entry={entry} />},
    {
      id: 'name', header: t('name'), rowHeader: true, sortBy: true, width: 'growCollapse',
      renderCell: entry => (
        <Link className={styles.entryName} href={href(locationOf(location.rootId, entry))} muted={false} title={entry.name}>
          {entry.name}
        </Link>
      ),
    },
    ...optionalColumns.filter(column => visible.includes(column.key)).map(column => ({
      id: column.key, header: t(column.label), sortBy: true, width: 'growCollapse' as const,
      renderCell: (entry: Row) => {
        const value = valueFor(entry, column.key, locale, t)
        return column.key === 'type' ? <Label>{value}</Label> : <span className={styles.cell} title={value}>{value}</span>
      },
    })),
    {
      id: 'actions', header: '', width: 'var(--base-size-40)',
      renderCell: entry => <EntryMenu entry={entry} share={share} open={onAction} download={onDownload} />,
    },
  ]

  return (
    <div className={styles.table}>
      <DataTable<Row> key={visible.join(',')} aria-labelledby={props.titleId} cellPadding="condensed"
        columns={columns} data={entries.map(entry => ({...entry, id: entry.path}))}
        initialSortColumn={props.sort} initialSortDirection={props.direction === 'asc' ? 'ASC' : 'DESC'}
        externalSorting onToggleSort={(key, direction) => props.onSort(key as SortKey, direction === 'ASC' ? 'asc' : 'desc')} />
    </div>
  )
}
