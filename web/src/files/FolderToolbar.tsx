import {useEffect, useRef, useState, type ReactNode} from 'react'
import {ActionList, ActionMenu, Button, ButtonGroup, IconButton, Stack} from '@primer/react'
import {ChevronDownIcon, DesktopDownloadIcon} from '@primer/octicons-react'
import type {Device, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {number} from '../i18n/format'
import {ExplorerHeader} from '../ui/ExplorerHeader'
import type {OpenAction} from './actions'
import {optionalColumns, type ColumnKey} from './columns'
import {FileTitle} from './Metadata'
import {basename, canWriteFolder} from './navigation'
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
  const writable = canWriteFolder(share, location.path)
  return (
    <ExplorerHeader title={<FileTitle id={titleId} title={label} detail={t('folderOn', {device: device.name})} />}
      facts={overview}
      actions={<Stack direction="horizontal" align="center" wrap="wrap" gap="condensed">
        <ButtonGroup>
          <Button size="medium" disabled={!writable} onClick={() => open({kind: 'upload'})}>{t('addFile')}</Button>
          <Button size="medium" disabled={!writable} onClick={() => open({kind: 'mkdir'})}>{t('newFolder')}</Button>
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
      </Stack>} />
  )
}

export function SelectionBar({count, busy, onDownloadSelected, onDownloadFolder}: {
  count: number
  busy: boolean
  onDownloadSelected: () => void
  onDownloadFolder: () => void
}) {
  const {t, locale} = useLanguage()
  const active = count > 0
  const previous = useRef(count)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (active) previous.current = count
    else setMenuOpen(false)
  }, [active, count])

  const shown = active ? count : previous.current
  return (
    <div className={selection.frame} data-active={active} inert={!active} aria-hidden={!active}>
      <div className={selection.clip}>
        <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" padding="normal"
          className={selection.bar}>
          <strong role="status">{shown ? t(shown === 1 ? 'selectedOne' : 'selectedMany', {count: number(shown, locale)}) : null}</strong>
          <ButtonGroup>
            <Button size="medium" variant="primary" leadingVisual={DesktopDownloadIcon} loading={busy}
              aria-label={t('downloadSelected')} onClick={onDownloadSelected}>
              {t(busy ? 'preparingDownload' : 'file')}
            </Button>
            <ActionMenu open={active && menuOpen} onOpenChange={setMenuOpen}>
              <ActionMenu.Anchor>
                <IconButton size="medium" variant="primary" icon={ChevronDownIcon} aria-label={t('filesMenu')} disabled={busy} />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay align="end" width="small">
                <ActionList>
                  <ActionList.Item onSelect={onDownloadSelected}>
                    <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('downloadSelected')}
                  </ActionList.Item>
                  <ActionList.Item onSelect={onDownloadFolder}>
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
