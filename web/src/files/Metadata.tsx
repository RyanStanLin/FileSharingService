import {Heading, Stack} from '@primer/react'
import {FileDirectoryFillIcon, FileIcon, FileSymlinkFileIcon} from '@primer/octicons-react'
import type {Entry} from '../api/types'
import {useLanguage, type Message} from '../i18n'
import {bytes, date, entryKind, number} from '../i18n/format'
import fileImage from '../assets/file.png'
import styles from './workspace.module.css'

export function EntryIcon({entry, detail = false}: {entry: Entry; detail?: boolean}) {
  if (entry.kind === 'file') {
    return <img src={fileImage} className={detail ? styles.largeFileIcon : styles.fileIcon} alt="" />
  }
  const Icon = entry.kind === 'directory' ? FileDirectoryFillIcon : entry.kind === 'symlink' ? FileSymlinkFileIcon : FileIcon
  return <Icon className={entry.kind === 'directory' ? styles.folderIcon : undefined} size={detail ? 32 : 16} />
}

export function FileTitle({id, title, detail, entry}: {id?: string; title: string; detail?: string; entry?: Entry}) {
  return (
    <Stack direction="horizontal" align="center" gap="normal">
      {entry && <span className={styles.thumbnail}><EntryIcon entry={entry} detail /></span>}
      <Stack.Item grow className={styles.titleArea}>
        <Heading as="h1" id={id} className={styles.title}>{title}</Heading>
        {detail && <div className={styles.caption}>{detail}</div>}
      </Stack.Item>
    </Stack>
  )
}

export function Metadata({entry, all = false}: {entry?: Entry; all?: boolean}) {
  const {t, locale} = useLanguage()
  if (!entry) return null
  const folder = entry.kind === 'directory'
  const summary = entry.folder
  const facts: [Message, string][] = folder
    ? [
        ['modified', date(entry.modifiedAt, locale)],
        ['size', summary ? bytes(summary.folderSize, locale) : t('missing')],
        ['filesCount', summary ? number(summary.filesCount, locale) : t('missing')],
        ['folders', summary ? number(summary.foldersCount, locale) : t('missing')],
      ]
    : [
        ['size', bytes(entry.size, locale)],
        ['created', date(entry.createdAt, locale, true)],
        ['modified', date(entry.modifiedAt, locale, true)],
        ['lastOpened', date(entry.lastOpenedAt, locale, true)],
      ]
  if (all) {
    if (folder) facts.push(['created', date(entry.createdAt, locale, true)], ['lastOpened', date(entry.lastOpenedAt, locale, true)])
    facts.push(['lastAccessed', date(entry.lastAccessedAt, locale, true)], ['kind', entryKind(entry, t)],
      ['owner', number(entry.owner, locale)], ['mode', entry.mode.toString(8).padStart(4, '0')],
      ['typeIdentifier', entry.fileType ?? t('missing')], ['path', entry.fullPath])
  }
  return (
    <Stack gap="tight">
      <Stack as="dl" direction="horizontal" wrap="wrap" gap="normal" className={styles.metadata}>
        {facts.map(([label, value]) => (
          <div key={label} className={styles.fact}>
            <dt>{t(label)}</dt><dd>{value}</dd>
          </div>
        ))}
      </Stack>
      {summary?.complete === false && <div className={styles.caption}>{t('summaryPartial')}</div>}
    </Stack>
  )
}
