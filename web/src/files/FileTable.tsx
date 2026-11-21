import {Button, Checkbox, Label, Link} from '@primer/react'
import {SortAscIcon, SortDescIcon} from '@primer/octicons-react'
import type {Direction} from '../api/files'
import type {Entry, Location, Share, SortKey} from '../api/types'
import {useLanguage} from '../i18n'
import type {OpenAction} from './actions'
import {optionalColumns, valueFor, type ColumnKey} from './columns'
import {EntryMenu} from './EntryMenu'
import {EntryIcon} from './Metadata'
import {href, locationOf} from './navigation'
import styles from './table.module.css'

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

function SortHeading({field, label, sort, direction, onSort}: {
  field: SortKey
  label: string
} & Pick<Props, 'sort' | 'direction' | 'onSort'>) {
  const current = field === sort
  const ascending = direction === 'asc'
  return (
    <th scope="col" aria-sort={current ? ascending ? 'ascending' : 'descending' : undefined}>
      <Button size="small" variant="invisible" block alignContent="start" className={styles.sortButton}
        trailingVisual={current ? ascending ? SortAscIcon : SortDescIcon : undefined}
        onClick={() => onSort(field, current && ascending ? 'desc' : 'asc')}>
        {label}
      </Button>
    </th>
  )
}

export function FileTable({titleId, entries, selected, setSelected, visible, location, share, sort, direction, onSort,
  onAction, onDownload}: Props) {
  const {t, locale} = useLanguage()
  const columns = optionalColumns.filter(column => visible.includes(column.key))
  const all = entries.length > 0 && entries.every(entry => selected.has(entry.path))
  const some = entries.some(entry => selected.has(entry.path))
  const sortProps = {sort, direction, onSort}

  function select(path: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(path)
    else next.delete(path)
    setSelected(next)
  }

  return (
    <table aria-labelledby={titleId} className={styles.table}>
      <colgroup>
        <col className={styles.checkColumn} />
        <col className={styles.iconColumn} />
        <col />
        {columns.map(column => <col key={column.key} />)}
        <col className={styles.menuColumn} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={styles.checkCell}>
            <Checkbox aria-label={t('selectAll')} checked={all} indeterminate={some && !all} disabled={!entries.length}
              onChange={event => setSelected(new Set(event.target.checked ? entries.map(entry => entry.path) : []))} />
          </th>
          <th scope="col" aria-hidden="true" />
          <SortHeading field="name" label={t('name')} {...sortProps} />
          {columns.map(column => <SortHeading key={column.key} field={column.key} label={t(column.label)} {...sortProps} />)}
          <th scope="col" aria-label={t('filesMenu')} />
        </tr>
      </thead>
      <tbody>
        {entries.map(entry => (
          <tr key={entry.path}>
            <td className={styles.checkCell}>
              <Checkbox aria-label={t('selectEntry', {name: entry.name})} checked={selected.has(entry.path)}
                onChange={event => select(entry.path, event.target.checked)} />
            </td>
            <td aria-hidden="true" className={styles.iconCell}><EntryIcon entry={entry} /></td>
            <th scope="row">
              <Link className={styles.entryName} href={href(locationOf(location.rootId, entry))} title={entry.name}>{entry.name}</Link>
            </th>
            {columns.map(({key}) => {
              const value = valueFor(entry, key, locale, t)
              return <td key={key} title={value}><span className={styles.cell}>{key === 'type' ? <Label>{value}</Label> : value}</span></td>
            })}
            <td className={styles.menuCell}>
              <EntryMenu entry={entry} share={share} open={onAction} download={onDownload} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
