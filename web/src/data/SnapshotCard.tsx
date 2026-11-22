import type {ReactNode} from 'react'
import type {Icon} from '@primer/octicons-react'
import type {DataObject, SnapshotTopic} from '../api/telemetry'
import {useLanguage, type Message} from '../i18n'
import {DataCard} from './DataCard'
import {DataFacts} from './DataFacts'
import type {Tone} from './categories'
import {object} from './format'
import type {TelemetryView} from './useTelemetry'

export function SnapshotCard({telemetry, topic, label, icon, tone, value, children}: {
  telemetry: TelemetryView
  topic: SnapshotTopic
  label: Message
  icon: Icon
  tone: Tone
  value?: DataObject
  children?: ReactNode
}) {
  const {t} = useLanguage()
  const snapshot = telemetry.samples[topic]
  return <DataCard title={t(label)} icon={icon} tone={tone} observedAt={snapshot?.observedAt}
    stale={snapshot && (snapshot.stale || !telemetry.connection.online)}>
    {children ?? <DataFacts value={value ?? object(snapshot?.value)} />}
  </DataCard>
}
