import {ActionList, ActionMenu, Button, ButtonGroup, IconButton, Stack} from '@primer/react'
import {ChevronDownIcon, DesktopDownloadIcon} from '@primer/octicons-react'
import type {Device, Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {number} from '../i18n/format'
import type {OpenAction} from './actions'
import {optionalColumns, type ColumnKey} from './columns'
import {FileTitle, Metadata} from './Metadata'
import {basename} from './navigation'
import styles from './workspace.module.css'

export function FolderHeader({device, location, titleId, share, summary, open, visible, setVisible}: {
  device: Device
  location: Location
  titleId: string
  share: Share
  summary?: Entry
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
        <Metadata entry={summary} />
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
  const count = selected.length
  return (
    <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" padding="normal" className={styles.selectionBar}>
      <strong role="status">{count ? t(count === 1 ? 'selectedOne' : 'selectedMany', {count: number(count, locale)}) : null}</strong>
      <ButtonGroup>
        <Button size="medium" variant="primary" leadingVisual={DesktopDownloadIcon} loading={busy}
          aria-label={t(count ? 'downloadSelected' : 'downloadFolder')} onClick={() => onDownload(selected)}>
          {t(busy ? 'preparingDownload' : 'file')}
        </Button>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton size="medium" variant="primary" icon={ChevronDownIcon} aria-label={t('filesMenu')} disabled={busy} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay align="end" width="small">
            <ActionList>
              {count > 0 && <ActionList.Item onSelect={() => onDownload(selected)}>
                <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('downloadSelected')}
              </ActionList.Item>}
              <ActionList.Item onSelect={() => onDownload([])}>
                <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('downloadFolder')}
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </ButtonGroup>
    </Stack>
  )
}
