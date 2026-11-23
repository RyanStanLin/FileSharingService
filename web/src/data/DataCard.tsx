import {useId, type ReactNode} from 'react'
import {Heading, Stack} from '@primer/react'
import {Card} from '@primer/react/experimental'
import {ChevronRightIcon, type Icon} from '@primer/octicons-react'
import type {Snapshot} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {Timestamp, timestampEpoch} from '../ui/Timestamp'
import styles from './dashboard.module.css'

interface CardProps {
  title: string
  icon: Icon
  observedAt?: Snapshot['observedAt']
  stale?: boolean
  href?: string
  children: ReactNode
  metric?: boolean
  heading?: 'h2' | 'h3'
}

export function DataCard({title, icon: Icon, observedAt, stale, href, metric, heading = 'h2', children}: CardProps) {
  const id = useId()
  const {t} = useLanguage()
  const label = <Stack direction="horizontal" align="center" gap="condensed">
    <Icon />
    <span>{title}</span>
  </Stack>

  return <Card as="section" shadow={false} padding="regular" aria-labelledby={id}
    className={metric ? `${styles.card} ${styles.metricCard}` : styles.card}>
    <Stack gap="normal" justify={metric ? 'space-between' : 'start'}>
      <Stack direction="horizontal" align="start" justify="space-between" gap="condensed">
        <Heading as={heading} id={id} className={styles.cardTitle}>
          {href ? <Card.Link href={href} fullCardHitArea>{label}</Card.Link> : label}
        </Heading>
        <Stack direction="horizontal" gap="tight" align="center" className={styles.cardMeta}>
          {timestampEpoch(observedAt) !== undefined && <Timestamp value={observedAt} />}
          {href && <ChevronRightIcon aria-hidden="true" />}
        </Stack>
      </Stack>
      {children}
      {stale && <span className={styles.stale}>{t('dataStale')}</span>}
    </Stack>
  </Card>
}

export function MetricValue({amount, unit, description}: {amount?: string; unit?: string; description?: ReactNode}) {
  const {t} = useLanguage()
  return <div className={styles.measure}>
    <div className={styles.measureLine}>
      <strong data-missing={amount === undefined ? '' : undefined}>{amount ?? t('dataNoSample')}</strong>
      {amount !== undefined && unit && <span>{unit}</span>}
    </div>
    {description && <span className={styles.measureDescription}>{description}</span>}
  </div>
}
