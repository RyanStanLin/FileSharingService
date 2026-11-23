import {useId, useMemo} from 'react'
import {Button, Heading, Stack} from '@primer/react'
import {HistoryIcon, SyncIcon} from '@primer/octicons-react'
import {readClipboardRecord} from '../api/clipboard'
import {useLanguage, type Translate} from '../i18n'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {useResource} from '../ui/async'
import type {ReadingChrome} from './ReadingPane'
import {ReadingTable} from './ReadingTable'
import {cell, objectDataset, valueCell} from './readingModel'
import {useClipboardArchive} from './useClipboardArchive'
import styles from './dashboard.module.css'

function clipboardText(content: string | null, t: Translate) {
  return content === '' ? t('dataClipboardEmptyText') : content ?? t('missing')
}

function ClipboardDetail({deviceId, id}: {deviceId: string; id: string}) {
  const {t, locale} = useLanguage()
  const contentLabel = useId()
  const detail = useResource(JSON.stringify([deviceId, id]), signal => readClipboardRecord(deviceId, id, signal))
  if (detail.error != null) return <Retry error={detail.error} refresh={detail.refresh} />
  if (!detail.data) return <Loading />

  const {content, ...fields} = detail.data
  const dataset = objectDataset(id, t('dataClipboardEvent'), fields, locale, t)
  return <>
    <ReadingTable nameTitle={dataset.nameTitle} columns={dataset.columns} rows={dataset.rows} dialog />
    <Stack as="section" aria-labelledby={contentLabel} gap="condensed">
      <Heading as="h3" id={contentLabel} variant="small">{t('dataClipboardContent')}</Heading>
      <p className={styles.clipboardText}>{clipboardText(content, t)}</p>
    </Stack>
  </>
}

export function useClipboardHistory({deviceId, newestEvent, streaming, chrome}: {
  deviceId: string | null
  newestEvent?: string
  streaming: boolean
  chrome: ReadingChrome
}) {
  const {t, locale} = useLanguage()
  const archive = useClipboardArchive(deviceId, streaming, newestEvent)
  const rows = useMemo(() => (archive.page?.items ?? []).map(record => ({
    id: record.id, name: cell(t('dataClipboardEvent')), icon: <HistoryIcon />,
    values: {time: valueCell('occurredAt', record.occurredAt, locale, t),
      content: {text: clipboardText(record.content, t), preview: true}},
    value: {id: record.id},
  })), [archive.page, locale, t])
  const archiveChrome: ReadingChrome = {
    ...chrome,
    pending: false,
    action: <Button size="medium" leadingVisual={SyncIcon} loading={archive.loading === 'recent'}
      onClick={archive.refresh}>{t('dataRefresh')}</Button>,
    notices: archive.error == null ? null : <Stack padding="normal"><ErrorText error={archive.error} /></Stack>,
  }
  return {
    chrome: archiveChrome,
    dataset: {
      key: 'clipboard', title: t('dataClipboardHistory'), nameTitle: t('dataEventKind'),
      columns: [{key: 'time', title: t('dataTime')}, {key: 'content', title: t('dataClipboardContent')}],
      rows, icons: true, details: true, pending: !archive.page && archive.error == null,
      empty: archive.error == null ? t('dataNoClipboardRecords') : null,
      snapshot: {observedAt: archive.page?.items[0]?.recordedAt ?? null, stale: false},
    },
    pagination: {
      cursor: !archive.loading && archive.moreError == null ? archive.page?.nextCursor ?? undefined : undefined,
      loading: archive.loading === 'older', error: archive.moreError, next: archive.next,
    },
    rowDetails: (row: {id: string}) => deviceId && <ClipboardDetail deviceId={deviceId} id={row.id} />,
  }
}
