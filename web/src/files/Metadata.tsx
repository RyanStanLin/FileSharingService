import {Spinner, Stack} from '@primer/react'
import {useMemo, type ReactNode} from 'react'
import type {Entry} from '../api/types'
import {useLanguage, type Message} from '../i18n'
import {bytes, entryKind, number} from '../i18n/format'
import {ExplorerFacts, ExplorerTitle} from '../ui/ExplorerHeader'
import {Timestamp} from '../ui/Timestamp'
import styles from '../ui/explorer.module.css'
import {EntryIcon} from './EntryIcon'
import iconStyles from './entryIcon.module.css'

export function FileTitle({id, title, detail, entry, thumbnail}: {id?: string; title: string; detail?: string; entry?: Entry; thumbnail?: string}) {
  return <ExplorerTitle id={id} title={title} detail={detail}
    visual={entry && <span className={iconStyles.thumbnail}><EntryIcon entry={entry} url={thumbnail} detail /></span>} />
}

export function FolderOverview({entry, entries, complete, pending}: {
  entry?: Entry
  entries: Entry[]
  complete: boolean
  pending: boolean
}) {
  const {t, locale} = useLanguage()
  const totals = useMemo(() => {
    if (!complete) return undefined
    let size = 0
    let folders = 0
    for (const item of entries) {
      if (item.kind === 'directory') folders++
      if (item.kind === 'file') size += item.size
    }
    return {size, folders, files: entries.length - folders}
  }, [complete, entries])
  return <ExplorerFacts title={t('visibleTotals')} items={[
    ['modified', entry ? <Timestamp value={entry.modifiedAt} variant="file" /> : pending ? <Spinner size="small" srText={t('loadingFolder')} /> : t('missing')],
    ['size', totals ? bytes(totals.size, locale) : t('missing')],
    ['filesCount', totals ? number(totals.files, locale) : t('missing')],
    ['folders', totals ? number(totals.folders, locale) : t('missing')],
  ]} />
}

export function Metadata({entry, all = false}: {entry?: Entry; all?: boolean}) {
  const {t, locale} = useLanguage()
  if (!entry) return null
  const folder = entry.kind === 'directory'
  const summary = entry.folder
  const variant = all ? 'exact' : 'file'
  const facts: [Message, ReactNode][] = folder
    ? [
        ['modified', <Timestamp value={entry.modifiedAt} variant={variant} />],
        ['size', summary ? bytes(summary.folderSize, locale) : t('missing')],
        ['filesCount', summary ? number(summary.filesCount, locale) : t('missing')],
        ['folders', summary ? number(summary.foldersCount, locale) : t('missing')],
      ]
    : [
        ['size', bytes(entry.size, locale)],
        ['created', <Timestamp value={entry.createdAt} variant={variant} />],
        ['modified', <Timestamp value={entry.modifiedAt} variant={variant} />],
        ['lastOpened', <Timestamp value={entry.lastOpenedAt} variant={variant} />],
      ]
  if (all) {
    if (folder) facts.push(['created', <Timestamp value={entry.createdAt} variant="exact" />],
      ['lastOpened', <Timestamp value={entry.lastOpenedAt} variant="exact" />])
    facts.push(['lastAccessed', <Timestamp value={entry.lastAccessedAt} variant="exact" />], ['kind', entryKind(entry, t)],
      ['owner', number(entry.owner, locale)], ['mode', entry.mode.toString(8).padStart(4, '0')],
      ['typeIdentifier', entry.fileType ?? t('missing')], ['path', entry.fullPath])
  }
  return (
    <Stack gap="tight">
      <ExplorerFacts items={facts} />
      {summary?.complete === false && <div className={styles.caption}>{t('summaryPartial')}</div>}
    </Stack>
  )
}
