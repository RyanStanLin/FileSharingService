import {useId, useState} from 'react'
import {Button, Stack} from '@primer/react'
import {stat, type Direction} from '../api/files'
import type {Device, Entry, Location, Share, SortKey} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {useRefreshSignal, useResource} from '../ui/async'
import type {OpenAction} from './actions'
import {defaultColumns, optionalColumns, type ColumnKey} from './columns'
import {FileTable} from './FileTable'
import {FolderHeader, SelectionBar} from './FolderToolbar'
import {useDirectory} from './useDirectory'
import styles from './workspace.module.css'

interface Props {
  device: Device
  share: Share
  location: Location
  hidden: boolean
  revision: number
  onAction: OpenAction
  onDownload: (entries: Entry[]) => void
  downloadBusy: boolean
}

function initialColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem('filesharing.columns') ?? 'null')
    if (Array.isArray(saved)) return optionalColumns.map(column => column.key).filter(key => saved.includes(key))
  } catch { return defaultColumns }
  return defaultColumns
}

export function FolderPanel({device, share, location, hidden, revision, onAction, onDownload, downloadBusy}: Props) {
  const {t} = useLanguage()
  const id = useId()
  const [visible, setVisible] = useState<ColumnKey[]>(initialColumns)
  const [sort, setSort] = useState<SortKey>(visible.includes('createdAt') ? 'createdAt' : 'name')
  const [direction, setDirection] = useState<Direction>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const view = useDirectory(device.id, location, {hidden, sort, direction})
  const summary = useResource(location.path, signal => stat(device.id, location, signal))
  useRefreshSignal(revision, view.refresh)
  useRefreshSignal(revision, summary.refresh)

  function toggleColumn(column: ColumnKey) {
    const next = visible.includes(column) ? visible.filter(item => item !== column) : [...visible, column]
    if (sort === column && !next.includes(column)) {
      setSort('name')
      setDirection('asc')
    }
    setVisible(next)
    localStorage.setItem('filesharing.columns', JSON.stringify(next))
  }

  function changeSort(next: SortKey, order: Direction) {
    setSort(next)
    setDirection(order)
    setSelected(new Set())
  }

  return (
    <>
      <FolderHeader device={device} location={location} titleId={id} share={share} summary={summary.data}
        open={onAction} visible={visible} setVisible={toggleColumn} />
      {!view.error && view.page && <SelectionBar selected={view.entries.filter(entry => selected.has(entry.path))}
        busy={downloadBusy} onDownload={onDownload} />}
      <Stack gap="none" className={styles.explorer} aria-busy={view.pending || view.loadingMore}>
        {!view.page && (view.error
          ? <Retry error={view.error} refresh={view.refresh} />
          : <Loading message="loadingFolder" />)}
        {view.page && <>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={t('files')}>
            <FileTable titleId={id} location={location} share={share} entries={view.entries}
              selected={selected} setSelected={setSelected} visible={visible} sort={sort} direction={direction}
              onSort={changeSort} onAction={onAction} onDownload={onDownload} />
          </div>
          {view.entries.length === 0 && <p className={styles.emptyFolder}>{t('emptyFolder')}</p>}
          {view.error != null && <div className={styles.pageAction}><ErrorText error={view.error} /></div>}
          {view.page.nextOffset != null && <div className={styles.pageAction}>
            <Button size="medium" loading={view.loadingMore} onClick={() => void view.next()}>{t('moreEntries')}</Button>
          </div>}
        </>}
      </Stack>
    </>
  )
}
