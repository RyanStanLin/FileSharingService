import {ActionList, Button, Stack} from '@primer/react'
import {ArrowLeftIcon, FileDirectoryFillIcon, FileIcon} from '@primer/octicons-react'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ErrorText, Loading} from '../ui/Feedback'
import uiStyles from '../ui/ui.module.css'
import {homeLocation, parent} from './navigation'
import {useAutoPage} from './useAutoPage'
import {useDirectory} from './useDirectory'
import styles from '../ui/explorer.module.css'

interface Props {
  device: string
  roots: Share[]
  source: Location
  entry: Entry
  target: Location
  hidden: boolean
  busy: boolean
  onTarget: (location: Location) => void
}

export function MovePicker({device, roots, source, entry, target, hidden, busy, onTarget}: Props) {
  const {t} = useLanguage()
  const view = useDirectory(device, target, {hidden, sort: 'name', direction: 'asc'})
  const tail = useAutoPage(view)
  const visible = view.entries.filter(item => source.rootId !== target.rootId || item.path !== entry.path)

  return (
    <Stack gap="condensed">
      {roots.length > 1 && <ChoiceMenu block disabled={busy} label={t('sharedFolders')} value={target.rootId}
        options={roots.map(root => ({value: root.id, label: root.primary ? t('userFolder') : root.label}))}
        onChange={value => {
          const next = roots.find(root => root.id === value)
          if (next) onTarget(homeLocation(next))
        }} />}
      <Stack direction="horizontal" align="center" gap="condensed">
        <Button size="medium" leadingVisual={ArrowLeftIcon} disabled={busy || !target.path}
          onClick={() => onTarget({...target, path: parent(target.path)})}>{t('upFolder')}</Button>
        <strong className={uiStyles.wrapText} title={target.path}>/{target.path}</strong>
      </Stack>
      {view.pending && !view.page && <Loading message="loadingFolder" />}
      <ErrorText error={view.moreError ?? (!view.page ? view.error : undefined)} />
      <ActionList aria-label={t('destination')}>
        {visible.map(item => (
          <ActionList.Item key={item.path} disabled={busy || item.kind !== 'directory'} onSelect={() => onTarget({...target, path: item.path})}>
            <ActionList.LeadingVisual>{item.kind === 'directory' ? <FileDirectoryFillIcon /> : <FileIcon />}</ActionList.LeadingVisual>
            {item.name}
          </ActionList.Item>
        ))}
      </ActionList>
      {view.loadingMore && <Loading message="loadingFolder" />}
      {view.error != null && !view.page && <Button size="medium" onClick={view.refresh}>{t('retry')}</Button>}
      {view.moreError != null && <Button size="medium" onClick={() => void view.next()}>{t('retry')}</Button>}
      {view.page?.nextOffset != null && <span className={styles.pageEnd} ref={tail} aria-hidden="true" />}
    </Stack>
  )
}
