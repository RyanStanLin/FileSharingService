import {useId, useRef, type RefObject} from 'react'
import {Button, FormControl, ProgressBar, Stack} from '@primer/react'
import type {UploadProgress} from '../api/transfers'
import {useLanguage} from '../i18n'
import styles from '../ui/ui.module.css'

export function UploadFileField({file, progress, problem, onChoose, button}: {
  file?: File
  progress?: UploadProgress
  problem?: string
  onChoose: (file: File) => void
  button: RefObject<HTMLButtonElement | null>
}) {
  const {t, locale} = useLanguage()
  const picker = useRef<HTMLInputElement>(null)
  const issueId = useId()
  const fraction = progress?.fraction ?? 0

  return <Stack gap="condensed">
    <input type="file" ref={picker} hidden onChange={event => {
      const selected = event.target.files?.[0]
      if (selected) onChoose(selected)
      event.target.value = ''
    }} />
    <Stack direction="horizontal" align="center" wrap="wrap" gap="condensed">
      <Button ref={button} size="medium" disabled={Boolean(progress)} aria-describedby={problem ? issueId : undefined}
        onClick={() => picker.current?.click()}>{t('chooseFile')}</Button>
      <span className={styles.wrapText}>{file?.name ?? t('noChosenFile')}</span>
    </Stack>
    {problem && <FormControl.Validation variant="error" id={issueId}>{problem}</FormControl.Validation>}
    {progress && <span role="status">{progress.phase === 'preparing' ? t('uploadPreparing') : progress.phase === 'committing'
      ? t('uploadCommitting') : t('uploading', {name: file?.name ?? '', percent: new Intl.NumberFormat(locale, {style: 'percent'}).format(fraction)})}</span>}
    {progress?.phase === 'uploading' && <ProgressBar progress={fraction * 100} aria-label={t('upload')} />}
  </Stack>
}
