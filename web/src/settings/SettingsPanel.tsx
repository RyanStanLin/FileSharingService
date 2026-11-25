import {useId, type ReactNode} from 'react'
import {Button, Heading, Stack} from '@primer/react'
import {CheckIcon} from '@primer/octicons-react'
import {ApiError} from '../api/client'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import styles from './settings.module.css'

interface Props {
  title: string
  description?: string
  actions?: ReactNode
  notice?: ReactNode
  onApply?: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactNode
}

export function SettingsPanel({title, description, actions, notice, onApply, disabled, busy, children}: Props) {
  const {t} = useLanguage()
  const form = useId()
  const heading = useId()
  return <>
    <Stack direction="horizontal" justify="space-between" align="center" wrap="wrap" gap="condensed" padding="normal" className={styles.header}>
      <Stack gap="tight" className={styles.rowText}>
        <Heading as="h1" id={heading} className={styles.title}>{title}</Heading>
        {description && <p className={styles.caption}>{description}</p>}
      </Stack>
      <Stack direction="horizontal" align="center" gap="condensed" wrap="wrap" className={styles.headerActions}>
        {actions}
        {onApply && <Button size="medium" type="submit" form={form} leadingVisual={CheckIcon} loading={busy} disabled={disabled}>
          {t('settingsApply')}
        </Button>}
      </Stack>
    </Stack>
    {notice && <div className={styles.notice}>{notice}</div>}
    <div className={styles.scroll} aria-labelledby={heading} aria-busy={busy}>
      {onApply ? <form id={form} onSubmit={event => {
        event.preventDefault()
        if (!busy && !disabled) onApply()
      }}>{children}</form> : children}
    </div>
  </>
}

export function SettingsBand({title, description, children}: {title?: string; description?: string; children: ReactNode}) {
  return <div className={styles.band}>
    <Stack gap="condensed" className={styles.inner}>
      {title && <Heading as="h2" className={styles.subheading}>{title}</Heading>}
      {description && <p className={styles.caption}>{description}</p>}
      {children}
    </Stack>
  </div>
}

export function SettingsNotice({error, saved, reload}: {error?: unknown; saved?: boolean; reload?: () => void}) {
  const {t} = useLanguage()
  const conflict = error instanceof ApiError && ['revision_conflict', 'profile_conflict', 'profile_or_revision_conflict',
    'agent_connection_changed', 'root_conflict'].includes(error.code)
  return <>
    <ErrorText error={error} />
    {conflict && reload && <div><Button size="medium" onClick={reload}>{t('settingsDiscard')}</Button></div>}
    {saved && !error && <p className={styles.success} role="status">{t('settingsSaved')}</p>}
  </>
}
