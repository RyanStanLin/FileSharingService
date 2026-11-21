import {ActionList, ActionMenu, IconButton} from '@primer/react'
import {DesktopDownloadIcon, FileMovedIcon, KebabHorizontalIcon, PencilIcon, TrashIcon, XIcon} from '@primer/octicons-react'
import type {Entry, Share} from '../api/types'
import {useLanguage} from '../i18n'
import type {OpenAction} from './actions'
import styles from './table.module.css'

export function EntryMenu({entry, share, open, download}: {
  entry: Entry
  share: Share
  open: OpenAction
  download: (entries: Entry[]) => void
}) {
  const {t} = useLanguage()
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton size="medium" variant="invisible" icon={KebabHorizontalIcon} aria-label={t('actions', {name: entry.name})} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end" width="small" className={styles.entryMenu}>
        <ActionList>
          <ActionList.Group title={entry.name}>
            {share.writable && <>
              <ActionList.Item onSelect={() => open({kind: 'move', entry})}>
                <ActionList.LeadingVisual><FileMovedIcon /></ActionList.LeadingVisual>{t('move')}
              </ActionList.Item>
              <ActionList.Item onSelect={() => open({kind: 'rename', entry})}>
                <ActionList.LeadingVisual><PencilIcon /></ActionList.LeadingVisual>{t('rename')}
              </ActionList.Item>
              <ActionList.Divider />
              <ActionList.Item onSelect={() => open({kind: 'trash', entry})}>
                <ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>{t('trash')}
              </ActionList.Item>
              <ActionList.Item onSelect={() => open({kind: 'remove', entry})}>
                <ActionList.LeadingVisual><XIcon /></ActionList.LeadingVisual>{t('delete')}
              </ActionList.Item>
            </>}
            {!share.writable && <ActionList.Item onSelect={() => open({kind: 'info', entry})}>{t('viewInfo')}</ActionList.Item>}
            {!share.writable && (entry.kind === 'file' || entry.kind === 'directory') && <>
              <ActionList.Item onSelect={() => download([entry])}>
                <ActionList.LeadingVisual><DesktopDownloadIcon /></ActionList.LeadingVisual>{t('download')}
              </ActionList.Item>
            </>}
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}
