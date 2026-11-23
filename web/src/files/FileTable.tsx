import {Checkbox, Label, Link} from '@primer/react'
import type {Direction} from '../api/files'
import type {Entry, Location, Share, SortKey} from '../api/types'
import {useLanguage} from '../i18n'
import {bytes, entryKind} from '../i18n/format'
import {ExplorerSortHeading} from '../ui/ExplorerSortHeading'
import {Timestamp} from '../ui/Timestamp'
import styles from '../ui/explorerTable.module.css'
import type {OpenAction} from './actions'
import {optionalColumns, type ColumnKey} from './columns'
import {ListEntryIcon} from './EntryIcon'
import {EntryMenu, type ClipboardMenu} from './EntryMenu'
import {href, locationOf} from './navigation'
import type {FileSelection} from './useFileSelection'

interface Props {
  titleId: string
  location: Location
  share: Share
  device: string
  selection: FileSelection
  visible: ColumnKey[]
  sort: SortKey
  direction: Direction
  onSort: (sort: SortKey, direction: Direction) => void
  onAction: OpenAction
  onDownload: (entries: Entry[]) => void
  clipboard: ClipboardMenu
}

export function FileTable({titleId, device, selection, visible, location, share, sort, direction, onSort,
  onAction, onDownload, clipboard}: Props) {
  const {t} = useLanguage()
  const columns = optionalColumns.filter(column => visible.includes(column.key))
  const {entries, count, total} = selection
  const all = count > 0 && count === total
  const sortProps = {sort, direction, onSort}

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
            <Checkbox aria-label={t('selectAll')} checked={all} indeterminate={count > 0 && !all} disabled={!total}
              onChange={event => event.target.checked ? selection.selectAll() : selection.clear()} />
          </th>
          <th scope="col" aria-hidden="true" />
          <ExplorerSortHeading field="name" label={t('name')} {...sortProps} />
          {columns.map(column => <ExplorerSortHeading key={column.key} field={column.key} label={t(column.label)} {...sortProps} />)}
          <th scope="col" aria-label={t('filesMenu')} />
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <tr key={entry.path} data-file-row="" data-selected={selection.includes(entry.path)}>
            <td className={styles.checkCell}>
              <Checkbox aria-label={t('selectEntry', {name: entry.name})} checked={selection.includes(entry.path)}
                onChange={() => selection.select(index, {toggle: true})} />
            </td>
            <td aria-hidden="true" className={styles.iconCell}><ListEntryIcon device={device} rootId={share.id} entry={entry} /></td>
            <th scope="row">
              <Link className={styles.entryName} href={href(locationOf(location.rootId, entry))} title={entry.name}
                data-file-link="" data-hidden-entry={entry.hidden || undefined} draggable={false}>{entry.name}</Link>
            </th>
            {columns.map(({key}) => <FileValue key={key} field={key} entry={entry} />)}
            <td className={styles.menuCell}>
              <EntryMenu entry={entry} share={share} open={onAction} download={onDownload} clipboard={clipboard} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FileValue({field, entry}: {field: ColumnKey; entry: Entry}) {
  const {t, locale} = useLanguage()
  if (field !== 'type' && field !== 'size') {
    return <td><span className={`${styles.cell} ${styles.timeCell}`}><Timestamp value={entry[field]} variant="file" /></span></td>
  }

  const value = field === 'type' ? entryKind(entry, t) : entry.kind === 'directory' ? t('missing') : bytes(entry.size, locale)
  return <td title={value}><span className={styles.cell}>{field === 'type' ? <Label>{value}</Label> : value}</span></td>
}
