import {useId, useRef} from 'react'
import {ActionList, ActionMenu, IconButton} from '@primer/react'
import {
  DesktopDownloadIcon, FileDirectoryFillIcon, FileDirectoryOpenFillIcon, FileIcon, FileMovedIcon,
  InfoIcon, KebabHorizontalIcon, PencilIcon, TrashIcon, UploadIcon, XIcon,
} from '@primer/octicons-react'
import type {Entry, Share} from '../api/types'
import {useLanguage} from '../i18n'
import type {OpenAction} from './actions'
import {canWriteEntry, canWriteFolder, locationOf, navigate} from './navigation'
import styles from './fileMenu.module.css'

interface MenuProps {
  entry: Entry
  share: Share
  open: OpenAction
  download: (entries: Entry[]) => void
}

export interface EntryContext {
  entry: Entry
  x: number
  y: number
  trigger: HTMLElement
}

function EntryActions({entry, share, open, download}: MenuProps) {
  const {t} = useLanguage()
  const writable = canWriteEntry(share, entry.path)
  const folder = entry.kind === 'directory'
  const canWriteInside = folder && canWriteFolder(share, entry.path)
  const OpenIcon = folder ? FileDirectoryOpenFillIcon : FileIcon
  return <ActionList>
    <ActionList.Group title={entry.name}>
      <ActionList.Item onSelect={() => navigate(locationOf(share.id, entry))}>
        <ActionList.LeadingVisual><OpenIcon /></ActionList.LeadingVisual>{t('openEntry')}
      </ActionList.Item>
      <ActionList.Item onSelect={() => open({kind: 'info', entry})}>
        <ActionList.LeadingVisual><InfoIcon /></ActionList.LeadingVisual>{t('viewInfo')}
      </ActionList.Item>
      {(folder || entry.kind === 'file') && <ActionList.Item onSelect={() => download([entry])}>
        <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('download')}
      </ActionList.Item>}
      {(writable || canWriteInside) && <ActionList.Divider />}
      {writable && <>
        <ActionList.Item onSelect={() => open({kind: 'rename', entry})}>
          <ActionList.LeadingVisual><PencilIcon /></ActionList.LeadingVisual>{t('rename')}
        </ActionList.Item>
        <ActionList.Item onSelect={() => open({kind: 'move', entry})}>
          <ActionList.LeadingVisual><FileMovedIcon /></ActionList.LeadingVisual>{t('move')}
        </ActionList.Item>
      </>}
      {canWriteInside && <>
        <ActionList.Item onSelect={() => open({kind: 'mkdir', folder: entry})}>
          <ActionList.LeadingVisual><FileDirectoryFillIcon /></ActionList.LeadingVisual>{t('newFolder')}
        </ActionList.Item>
        <ActionList.Item onSelect={() => open({kind: 'upload', folder: entry})}>
          <ActionList.LeadingVisual><UploadIcon /></ActionList.LeadingVisual>{t('addFile')}
        </ActionList.Item>
      </>}
      {writable && <>
        <ActionList.Divider />
        <ActionList.Item onSelect={() => open({kind: 'trash', entry})}>
          <ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>{t('trash')}
        </ActionList.Item>
        <ActionList.Item onSelect={() => open({kind: 'remove', entry})}>
          <ActionList.LeadingVisual><XIcon /></ActionList.LeadingVisual>{t('delete')}
        </ActionList.Item>
      </>}
    </ActionList.Group>
  </ActionList>
}

export function EntryMenu(props: MenuProps) {
  const {t} = useLanguage()
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton size="medium" variant="invisible" icon={KebabHorizontalIcon} aria-label={t('actions', {name: props.entry.name})} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end" width="small" className={styles.entryMenu}>
        <EntryActions {...props} />
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

export function ContextEntryMenu({context, close, ...props}: Omit<MenuProps, 'entry'> & {
  context: EntryContext
  close: () => void
}) {
  const {t} = useLanguage()
  const label = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const trigger = useRef(context.trigger)
  return <>
    <span id={label} aria-hidden="true" className={styles.contextAnchor} ref={node => {
      anchor.current = node
      node?.style.setProperty('--menu-x', context.x + 'px')
      node?.style.setProperty('--menu-y', context.y + 'px')
    }}>{t('actions', {name: context.entry.name})}</span>
    <ActionMenu anchorRef={anchor} open onOpenChange={open => { if (!open) close() }}>
      <ActionMenu.Overlay width="small" maxHeight="large" aria-labelledby={label}
        className={styles.entryMenu} returnFocusRef={trigger} displayInViewport>
        <EntryActions {...props} entry={context.entry} />
      </ActionMenu.Overlay>
    </ActionMenu>
  </>
}
