import {useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent} from 'react'
import {Button, Stack} from '@primer/react'
import {stat} from '../api/files'
import type {Device, Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {useResource} from '../ui/async'
import explorerStyles from '../ui/explorer.module.css'
import type {DownloadSelection, OpenAction} from './actions'
import {ContextEntryMenu, type EntryContext} from './EntryMenu'
import {FileTable} from './FileTable'
import {FolderHeader, SelectionBar} from './FolderToolbar'
import {FolderOverview} from './Metadata'
import {useAutoPage} from './useAutoPage'
import type {Explorer} from './useExplorer'
import {useExplorerInput} from './useExplorerInput'
import {useFileSelection} from './useFileSelection'
import {useMarqueeSelection} from './useMarqueeSelection'
import selectionStyles from './selection.module.css'
import styles from './workspace.module.css'

interface Props {
  device: Device
  share: Share
  location: Location
  explorer: Explorer
  rootEntry?: Entry
  rootPending: boolean
  onAction: OpenAction
  onDownload: DownloadSelection
  downloadBusy: boolean
}

export function FolderPanel({device, share, location, explorer, rootEntry, rootPending, onAction, onDownload, downloadBusy}: Props) {
  const {t} = useLanguage()
  const id = useId()
  const scrollRoot = useRef<HTMLDivElement>(null)
  const [context, setContext] = useState<EntryContext>()
  const {view, visible, sort, direction, toggleColumn, changeSort} = explorer
  const selection = useFileSelection(device, location, explorer)
  const {onGroupClick, ...input} = useExplorerInput(location, selection, () => void view.next())
  const {marquee, dragCount, onPointerDown, onClickCapture, isSuppressingClick} = useMarqueeSelection(selection)
  const snapshot = view.page?.snapshotRevision
  const statKey = !location.path || snapshot === undefined ? null : JSON.stringify([location.rootId, location.path, snapshot])
  const stamp = useResource(statKey, signal => stat(device.id, location, signal, false, 'background'))
  const tail = useAutoPage(view, scrollRoot)
  const info = location.path ? stamp : {data: rootEntry, pending: rootPending}
  const refreshError = view.moreError ?? view.error

  function openContext(row: HTMLTableRowElement, point?: {x: number; y: number}) {
    const entry = view.entries[row.sectionRowIndex]
    const trigger = row.querySelector<HTMLElement>('[data-file-link]')
    if (!entry || !trigger) return
    const bounds = trigger.getBoundingClientRect()
    const x = Math.min(Math.max(0, point?.x ?? bounds.left), window.innerWidth - 1)
    const y = Math.min(Math.max(0, point?.y ?? bounds.bottom), window.innerHeight - 1)
    if (!selection.includes(entry.path)) selection.select(row.sectionRowIndex)
    setContext({entry, trigger, x, y})
  }

  function onContextMenu(event: MouseEvent<HTMLElement>) {
    const row = event.target instanceof Element ? event.target.closest<HTMLTableRowElement>('[data-file-row]') : null
    if (!row || !event.currentTarget.contains(row)) return
    event.preventDefault()
    openContext(row, event.clientX || event.clientY ? {x: event.clientX, y: event.clientY} : undefined)
  }

  function onExplorerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && event.target instanceof Element) {
      const selectedIndex = view.entries.findIndex(entry => selection.includes(entry.path))
      const row = event.target.closest<HTMLTableRowElement>('[data-file-row]') ??
        event.currentTarget.querySelector('tbody')?.rows[selectedIndex]
      if (row && event.currentTarget.contains(row)) {
        event.preventDefault()
        openContext(row)
        return
      }
    }
    input.onKeyDown(event)
  }

  return (
    <>
      <FolderHeader device={device} location={location} titleId={id} share={share}
        overview={<FolderOverview entry={info.data} entries={view.entries} complete={view.page?.nextOffset === null}
          pending={info.pending || !view.page && view.pending} />}
        open={onAction} visible={visible} setVisible={toggleColumn} />
      <Stack gap="none" className={styles.folderArea} onClickCapture={(event: MouseEvent<HTMLElement>) => {
        if (!isSuppressingClick()) onGroupClick(event)
      }}>
        <SelectionBar count={dragCount ?? selection.count} busy={downloadBusy}
          onDownloadSelected={() => onDownload(selection.downloadEntries)} onDownloadFolder={() => onDownload([])} />
        <Stack ref={scrollRoot} gap="none" className={explorerStyles.body} aria-busy={view.pending || view.loadingMore} tabIndex={-1}
          {...input} onPointerDown={onPointerDown} onClickCapture={onClickCapture}
          onContextMenu={onContextMenu} onKeyDown={onExplorerKeyDown}
          onDragStart={(event: DragEvent<HTMLElement>) => {
            if (event.target instanceof Element && event.target.closest('[data-file-row]')) event.preventDefault()
          }}>
          {!view.page && (view.error
            ? <Retry error={view.error} refresh={view.refresh} />
            : <Loading message="loadingFolder" />)}
          {view.page && <>
            <div className={explorerStyles.tableScroll} tabIndex={0} role="region" aria-label={t('files')} aria-keyshortcuts="Meta+A">
              <FileTable titleId={id} location={location} share={share} device={device.id}
                selection={selection} visible={visible} sort={sort} direction={direction}
                onSort={(field, order) => {
                  selection.clear()
                  changeSort(field, order)
                }} onAction={onAction} onDownload={onDownload} />
            </div>
            {view.entries.length === 0 && <p className={explorerStyles.empty}>{t('emptyFolder')}</p>}
            {view.loadingMore && <Loading message="loadingFolder" />}
            {refreshError != null && <Stack gap="condensed" padding="normal" align="center">
              <ErrorText error={refreshError} />
              <Button size="medium" onClick={view.moreError != null ? () => void view.next() : view.refresh}>{t('retry')}</Button>
            </Stack>}
            {view.page.nextOffset !== null && <span className={explorerStyles.pageEnd} ref={tail} aria-hidden="true" />}
          </>}
        </Stack>
      </Stack>
      {context && <ContextEntryMenu key={JSON.stringify([context.entry.path, context.x, context.y])} context={context}
        close={() => setContext(current => current === context ? undefined : current)} share={share} open={onAction} download={onDownload} />}
      <div className={selectionStyles.marquee} ref={marquee} hidden aria-hidden="true" />
    </>
  )
}
