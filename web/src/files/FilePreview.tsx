import {useState} from 'react'
import {Button, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {prepareFileDownload} from '../api/transfers'
import type {Entry} from '../api/types'
import {useLanguage} from '../i18n'
import {entryKind} from '../i18n/format'
import {ErrorText, Loading} from '../ui/Feedback'
import {useTask} from '../ui/async'
import styles from './filePreview.module.css'

interface Props {
  device: string
  rootId: string
  entry: Entry
  url?: string
  pending: boolean
}

export function FilePreview({device, rootId, entry, url, pending}: Props) {
  const {t} = useLanguage()
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [original, setOriginal] = useState<{url: string; loaded: boolean}>()
  const [imageError, setImageError] = useState<ApiError>()
  const task = useTask()
  const isImage = entry.thumbnail === 'image'
  const canPreview = isImage || entry.thumbnail === 'pdf'
  const loadingOriginal = task.busy || Boolean(original && !original.loaded)

  function loadOriginal() {
    if (loadingOriginal || original?.loaded) return
    setImageError(undefined)
    void task.run(async signal => {
      const source = await prepareFileDownload(device, rootId, entry, signal)
      if (!signal.aborted) setOriginal({url: source.url, loaded: false})
    })
  }

  return (
    <Stack gap="condensed" padding="normal" className={styles.preview}>
      <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" wrap="wrap">
        <strong>{t('preview', {kind: entry.thumbnail === 'pdf' ? 'PDF' : entryKind(entry, t)})}</strong>
        {isImage && !original?.loaded && <Button size="medium" onClick={loadOriginal} loading={loadingOriginal}
          loadingAnnouncement={t('loadingOriginal')}>{t('loadOriginal')}</Button>}
      </Stack>
      <ErrorText error={task.error ?? imageError} />
      <div className={styles.stage} aria-busy={loadingOriginal}>
        {!original?.loaded && (canPreview && pending && !url ? <Loading /> : canPreview && url && !thumbnailFailed
          ? <img src={url} alt={entry.name} onError={() => setThumbnailFailed(true)} />
          : <p>{t('previewUnavailable')}</p>)}
        {original && <img key={original.url} src={original.url} alt={entry.name} hidden={!original.loaded}
          onLoad={() => setOriginal({...original, loaded: true})}
          onError={() => {
            setOriginal(undefined)
            setImageError(new ApiError(422, 'original_preview_failed'))
          }} />}
      </div>
    </Stack>
  )
}
