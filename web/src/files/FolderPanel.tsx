import {useId, useState} from 'react'
import {Button, Stack} from '@primer/react'
import {stat} from '../api/files'
import type {Device, Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {useResource} from '../ui/async'
import type {OpenAction} from './actions'
import {FileTable} from './FileTable'
import {FolderHeader, SelectionBar} from './FolderToolbar'
import {FolderOverview} from './Metadata'
import {useAutoPage} from './useAutoPage'
import type {Explorer} from './useExplorer'
import styles from './workspace.module.css'

interface Props {
  device: Device
  share: Share
  location: Location
  explorer: Explorer
  rootEntry?: Entry
  rootPending: boolean
  onAction: OpenAction
  onDownload: (entries: Entry[]) => void
  downloadBusy: boolean
}

export function FolderPanel({device, share, location, explorer, rootEntry, rootPending, onAction, onDownload, downloadBusy}: Props) {
  const {t} = useLanguage()
  const id = useId()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const {view, visible, sort, direction, toggleColumn, changeSort} = explorer
  const snapshot = view.page?.snapshotRevision
  const statKey = !location.path || snapshot === undefined ? null : JSON.stringify([location.rootId, location.path, snapshot])
  const stamp = useResource(statKey, signal => stat(device.id, location, signal, false, 'background'))
  const tail = useAutoPage(view)
  const info = location.path ? stamp : {data: rootEntry, pending: rootPending}
  const chosen = view.entries.filter(entry => selected.has(entry.path))
  const refreshError = view.moreError ?? view.error

  return (
    <>
      <FolderHeader device={device} location={location} titleId={id} share={share}
        overview={<FolderOverview entry={info.data} entries={view.entries} complete={view.page?.nextOffset === null}
          pending={info.pending || !view.page && view.pending} />}
        open={onAction} visible={visible} setVisible={toggleColumn} />
      <SelectionBar selected={chosen} busy={downloadBusy} onDownload={onDownload} />
      <Stack gap="none" className={styles.explorer} aria-busy={view.pending || view.loadingMore}>
        {!view.page && (view.error
          ? <Retry error={view.error} refresh={view.refresh} />
          : <Loading message="loadingFolder" />)}
        {view.page && <>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={t('files')}>
            <FileTable titleId={id} location={location} share={share} entries={view.entries}
              selected={selected} setSelected={setSelected} visible={visible} sort={sort} direction={direction}
              onSort={(field, order) => {
                setSelected(new Set())
                changeSort(field, order)
              }} onAction={onAction} onDownload={onDownload} />
          </div>
          {view.entries.length === 0 && <p className={styles.emptyFolder}>{t('emptyFolder')}</p>}
          {view.loadingMore && <Loading message="loadingFolder" />}
          {refreshError != null && <Stack gap="condensed" padding="normal" align="center">
            <ErrorText error={refreshError} />
            <Button size="medium" onClick={view.moreError != null ? () => void view.next() : view.refresh}>{t('retry')}</Button>
          </Stack>}
          {view.page.nextOffset !== null && <span className={styles.pageEnd} ref={tail} aria-hidden="true" />}
        </>}
      </Stack>
    </>
  )
}
