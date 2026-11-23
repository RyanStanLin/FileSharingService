import type {ReactNode} from 'react'
import {Heading, Stack} from '@primer/react'
import {useLanguage, type Message} from '../i18n'
import styles from './explorer.module.css'

export function ExplorerTitle({id, title, detail, visual, muted}: {
  id?: string; title: string; detail?: string; visual?: ReactNode; muted?: boolean
}) {
  return <Stack direction="horizontal" align="center" gap="normal">
    {visual}
    <Stack.Item grow className={styles.titleArea}>
      <Heading as="h1" id={id} className={styles.title} data-muted={muted || undefined}>{title}</Heading>
      {detail && <div className={styles.caption}>{detail}</div>}
    </Stack.Item>
  </Stack>
}

export function ExplorerFacts({items, title}: {items: [Message, ReactNode][]; title?: string}) {
  const {t} = useLanguage()
  return <Stack as="dl" direction="horizontal" wrap="wrap" gap="normal" className={styles.metadata} title={title}>
    {items.map(([label, value]) => <div key={label} className={styles.fact}>
      <dt>{t(label)}</dt><dd>{value}</dd>
    </div>)}
  </Stack>
}

export function ExplorerHeader({title, facts, actions}: {title: ReactNode; facts?: ReactNode; actions?: ReactNode}) {
  return <Stack direction="horizontal" align="end" justify="space-between" wrap="wrap" gap="condensed" padding="normal"
    className={styles.header}>
    <Stack gap="condensed" className={styles.titleArea}>
      {title}
      {facts}
    </Stack>
    {actions}
  </Stack>
}
