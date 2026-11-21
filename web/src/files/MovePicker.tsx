import {ActionList, Button, FormControl, Select, Stack} from '@primer/react'
import {ArrowLeftIcon, FileDirectoryFillIcon} from '@primer/octicons-react'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {homeLocation, parent} from './navigation'
import {useDirectory} from './useDirectory'

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
  const folders = view.entries.filter(item => item.kind === 'directory' &&
    (source.rootId !== target.rootId || item.path !== entry.path))

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
      <ErrorText error={view.error} />
      <ActionList aria-label={t('destination')}>
        {folders.map(folder => (
          <ActionList.Item key={folder.path} onSelect={() => onTarget({...target, path: folder.path})}>
            <ActionList.LeadingVisual><FileDirectoryFillIcon /></ActionList.LeadingVisual>
            {folder.name}
          </ActionList.Item>
        ))}
      </ActionList>
      {view.error != null && <Button size="medium" onClick={view.refresh}>{t('retry')}</Button>}
      {view.page?.nextOffset != null &&
        <Button size="medium" loading={view.loadingMore} onClick={() => void view.next()}>{t('moreEntries')}</Button>}
    </Stack>
  )
}
