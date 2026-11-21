import {useEffect, useRef, useState, type ReactNode} from 'react'
import {ActionList, ActionMenu, Button, ButtonGroup, IconButton, Stack} from '@primer/react'
import {ChevronDownIcon, DesktopDownloadIcon} from '@primer/octicons-react'
import type {Device, Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {number} from '../i18n/format'
import type {OpenAction} from './actions'
import {optionalColumns, type ColumnKey} from './columns'
import {FileTitle} from './Metadata'
import {basename} from './navigation'
import styles from './workspace.module.css'
import selection from './selection.module.css'

export function FolderHeader({device, location, titleId, share, overview, open, visible, setVisible}: {
  device: Device
  location: Location
  titleId: string
  share: Share
  overview: ReactNode
  open: OpenAction
  visible: ColumnKey[]
  setVisible: (column: ColumnKey) => void
}) {
  const {t, locale} = useLanguage()
  const label = location.path ? basename(location.path) : share.primary ? t('userFolder') : share.label
  return (
    <Stack direction="horizontal" align="end" justify="space-between" wrap="wrap" gap="condensed" padding="normal"
      className={styles.folderHeader}>
      <Stack gap="condensed" className={styles.titleArea}>
        <FileTitle id={titleId} title={label} detail={t('folderOn', {device: device.name})} />
        {overview}
      </Stack>
      <Stack direction="horizontal" align="center" wrap="wrap" gap="condensed">
        <ButtonGroup>
          <Button size="medium" disabled={!share.writable} onClick={() => open({kind: 'upload'})}>{t('addFile')}</Button>
          <Button size="medium" disabled={!share.writable} onClick={() => open({kind: 'mkdir'})}>{t('newFolder')}</Button>
          <Button size="medium" onClick={() => open({kind: 'info'})}>{t('viewInfo')}</Button>
        </ButtonGroup>
        <ActionMenu>
          <ActionMenu.Button size="medium">{t('columns', {count: number(visible.length, locale)})}</ActionMenu.Button>
          <ActionMenu.Overlay align="end" width="small">
            <ActionList selectionVariant="multiple">
              {optionalColumns.map(column => (
                <ActionList.Item key={column.key} selected={visible.includes(column.key)} onSelect={() => setVisible(column.key)}>
                  {t(column.label)}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </Stack>
    </Stack>
  )
}

export function SelectionBar({selected, busy, onDownload}: {
  selected: Entry[]
  busy: boolean
  onDownload: (entries: Entry[]) => void
}) {
  const {t, locale} = useLanguage()
  const active = selected.length > 0
  const previous = useRef(selected)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (active) previous.current = selected
    else setMenuOpen(false)
  }, [active, selected])

  const files = active ? selected : previous.current
  const count = files.length
  return (
    <div className={selection.frame} data-active={active} inert={!active} aria-hidden={!active}>
      <div className={selection.clip}>
        <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" padding="normal"
          className={selection.bar}>
          <strong role="status">{count ? t(count === 1 ? 'selectedOne' : 'selectedMany', {count: number(count, locale)}) : null}</strong>
          <ButtonGroup>
            <Button size="medium" variant="primary" leadingVisual={DesktopDownloadIcon} loading={busy}
              aria-label={t('downloadSelected')} onClick={() => onDownload(files)}>
              {t(busy ? 'preparingDownload' : 'file')}
            </Button>
            <ActionMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
              <ActionMenu.Anchor>
                <IconButton size="medium" variant="primary" icon={ChevronDownIcon} aria-label={t('filesMenu')} disabled={busy} />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay align="end" width="small">
                <ActionList>
                  <ActionList.Item onSelect={() => onDownload(files)}>
                    <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('downloadSelected')}
                  </ActionList.Item>
                  <ActionList.Item onSelect={() => onDownload([])}>
                    <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('downloadFolder')}
                  </ActionList.Item>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </ButtonGroup>
        </Stack>
      </div>
    </div>
  )
}
