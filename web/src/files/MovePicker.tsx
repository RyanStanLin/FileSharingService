import {ActionList, Button, FormControl, Select, Stack} from '@primer/react'
import {ArrowLeftIcon, FileDirectoryFillIcon, FileIcon} from '@primer/octicons-react'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {homeLocation, parent} from './navigation'
import {useAutoPage} from './useAutoPage'
import {useDirectory} from './useDirectory'
import styles from './workspace.module.css'

interface Props {
  device: string
  roots: Share[]
  source: Location
  entry: Entry
  target: Location
  hidden: boolean
  onTarget: (location: Location) => void
}

export function MovePicker({device, roots, source, entry, target, hidden, onTarget}: Props) {
  const {t} = useLanguage()
  const view = useDirectory(device, target, {hidden, sort: 'name', direction: 'asc'})
  const tail = useAutoPage(view)
  const visible = view.entries.filter(item => source.rootId !== target.rootId || item.path !== entry.path)

  return (
    <Stack gap="condensed">
      {roots.length > 1 && <FormControl>
        <FormControl.Label>{t('sharedFolders')}</FormControl.Label>
        <Select size="medium" block value={target.rootId} onChange={event => {
          const next = roots.find(root => root.id === event.target.value)
          if (next) onTarget(homeLocation(next))
        }}>
          {roots.map(root => <Select.Option key={root.id} value={root.id}>{root.primary ? t('userFolder') : root.label}</Select.Option>)}
        </Select>
      </FormControl>}
      <Stack direction="horizontal" align="center" gap="condensed">
        <Button size="medium" leadingVisual={ArrowLeftIcon} disabled={!target.path}
          onClick={() => onTarget({...target, path: parent(target.path)})}>{t('upFolder')}</Button>
        <strong title={target.path}>/{target.path}</strong>
      </Stack>
      {view.pending && !view.page && <Loading message="loadingFolder" />}
      <ErrorText error={view.moreError ?? (!view.page ? view.error : undefined)} />
      <ActionList aria-label={t('destination')}>
        {visible.map(item => (
          <ActionList.Item key={item.path} disabled={item.kind !== 'directory'} onSelect={() => onTarget({...target, path: item.path})}>
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
