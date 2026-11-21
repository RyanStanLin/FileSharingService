import {useState} from 'react'
import {Button, ButtonGroup, Stack} from '@primer/react'
import {DesktopDownloadIcon} from '@primer/octicons-react'
import {stat, thumbnail} from '../api/files'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {entryKind} from '../i18n/format'
import {Loading, Retry} from '../ui/Feedback'
import {useRefreshSignal, useResource} from '../ui/async'
import type {OpenAction} from './actions'
import {FileTitle, Metadata} from './Metadata'
import styles from './workspace.module.css'

function FilePreview({device, share, entry}: {device: string; share: Share; entry: Entry}) {
  const {t} = useLanguage()
  const [failed, fail] = useState(false)
  const canPreview = entry.thumbnail === 'image' || entry.thumbnail === 'pdf'
  return (
    <Stack gap="condensed" padding="normal" className={styles.preview}>
      <strong>{t('preview', {kind: entry.thumbnail === 'pdf' ? 'PDF' : entryKind(entry, t)})}</strong>
      <div className={styles.previewStage}>
        {canPreview && !failed
          ? <img src={thumbnail(device, share.id, entry)} alt={entry.name} onError={() => fail(true)} />
          : <p>{t('previewUnavailable')}</p>}
      </div>
    </Stack>
  )
}

export function FilePanel({device, share, location, revision, onAction, onDownload, downloadBusy}: {
  device: string
  share: Share
  location: Location
  revision: number
  onAction: OpenAction
  onDownload: (entries: Entry[]) => void
  downloadBusy: boolean
}) {
  const {t} = useLanguage()
  const info = useResource(location.path, signal => stat(device, location, signal, false))
  useRefreshSignal(revision, info.refresh)
  if (info.error) return <Retry error={info.error} refresh={info.refresh} />
  if (!info.data) return <Loading />
  const entry = info.data

  return (
    <>
      <Stack direction="horizontal" align="end" justify="space-between" wrap="wrap" gap="condensed" padding="normal" className={styles.fileHeader}>
        <Stack gap="condensed" className={styles.titleArea}>
          <FileTitle title={entry.name} detail={entryKind(entry, t)} entry={entry} />
          <Metadata entry={entry} />
        </Stack>
        <ButtonGroup>
          <Button size="medium" disabled={!share.writable} onClick={() => onAction({kind: 'rename', entry})}>{t('rename')}</Button>
          <Button size="medium" variant="primary" leadingVisual={DesktopDownloadIcon} loading={downloadBusy}
            disabled={entry.kind !== 'file'} onClick={() => onDownload([entry])}>{t('download')}</Button>
        </ButtonGroup>
      </Stack>
      <FilePreview key={entry.version} device={device} share={share} entry={entry} />
    </>
  )
}
