import {Button, Heading, Spinner, Stack} from '@primer/react'
import type {ReactNode} from 'react'
import {useLanguage, type Message} from '../i18n'
import styles from './ui.module.css'

export function ErrorText({error}: {error: unknown}) {
  const {errorText} = useLanguage()
  return error ? <p className={styles.error} role="alert">{errorText(error)}</p> : null
}

export function Loading({message = 'loading'}: {message?: Message}) {
  const {t} = useLanguage()
  return (
    <Stack direction="horizontal" align="center" justify="center" gap="condensed" padding="normal" className={styles.loading} role="status">
      <Spinner size="small" srText="" />
      {t(message)}
    </Stack>
  )
}

export function State({title, description, error, children, tone = 'default'}: {
  title?: string
  description?: string
  error?: unknown
  children?: ReactNode
  tone?: 'default' | 'locked'
}) {
  return (
    <Stack className={tone === 'locked' ? styles.locked : styles.state} align="center" justify="center" gap="none" padding="normal">
      {title && <Heading as="h1" className={styles.stateTitle}>{title}</Heading>}
      {description && <p className={styles.stateDescription}>{description}</p>}
      <ErrorText error={error} />
      {children && <div className={styles.stateAction}>{children}</div>}
    </Stack>
  )
}

export function Retry({error, refresh}: {error: unknown; refresh: () => void}) {
  const {t} = useLanguage()
  return <State error={error}><Button size="medium" onClick={refresh}>{t('retry')}</Button></State>
}
