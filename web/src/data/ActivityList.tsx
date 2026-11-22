import {useState} from 'react'
import {Select} from '@primer/react'
import {HistoryIcon} from '@primer/octicons-react'
import {activityTopics, recentMinutes, type ActivityTopic, type History} from '../api/telemetry'
import {useLanguage, type Message} from '../i18n'
import {ReadingPane, type ReadingChrome} from './ReadingPane'
import {codeLabel} from './dataFields'
import {object, textValue} from './format'
import {cell, valueCell, type ReadingRow} from './readingModel'

const titles: Record<ActivityTopic, Message> = {
  'connection.changed': 'dataConnection',
  'applications.changed': 'dataApplicationEvent',
  'storage.changed': 'dataStorageEvent',
  'system.changed': 'dataSystemEvent',
  'lid.changed': 'dataLidEvent',
  'clipboard.changed': 'dataClipboardEvent',
  'telemetry.gap': 'dataGapEvent',
  'jobs.changed': 'dataJobEvent',
  'transfers.changed': 'dataTransferEvent',
}

export function ActivityList({history, pending, chrome}: {history: History; pending: boolean; chrome: ReadingChrome}) {
  const {t, locale} = useLanguage()
  const [filter, setFilter] = useState<ActivityTopic | 'all'>('all')
  const events = filter === 'all' ? activityTopics.flatMap(topic => history[topic] ?? []) : history[filter] ?? []
  const rows: ReadingRow[] = events.map(event => {
    const payload = object(event.payload)
    const time = textValue(payload?.occurredAt) ?? event.time
    const kind = textValue(payload?.kind)
    const state = textValue(payload?.state)
    const record = object(payload?.application ?? payload?.storage)
    const name = textValue(record?.name ?? record?.mountPath ?? record?.id)
    const presence = typeof payload?.online === 'boolean' ? t(payload.online ? 'online' : 'offline') : undefined
    const detail = [kind ? codeLabel(kind, locale) : undefined, state ? codeLabel(state, locale) : presence, name]
      .filter(Boolean).join(' · ')
    return {id: event.sequence, name: cell(t(titles[event.topic as ActivityTopic])), icon: <HistoryIcon />,
      values: {time: valueCell('occurredAt', time, locale, t), information: cell(detail || t('missing'))},
      value: event.topic === 'clipboard.changed' ? {occurredAt: time} : {...payload, occurredAt: time}}
  })
  const observedAt = events.reduce<string | null>((latest, event) =>
    !latest || Date.parse(event.time) > Date.parse(latest) ? event.time : latest, null)
  return <ReadingPane chrome={chrome} filter={filter} dataset={{
    key: 'events', title: t('dataEvents'), nameTitle: t('dataEventKind'), description: t('dataWindow', {minutes: recentMinutes}),
    columns: [{key: 'time', title: t('dataTime')}, {key: 'information', title: t('dataDescription')}],
    rows, icons: true, details: true, sort: {key: 'time', direction: 'desc'}, empty: t('dataNoEvents'), pending,
    snapshot: {observedAt, stale: false},
  }} controls={<Select size="medium" aria-label={t('dataEventKind')} value={filter}
    onChange={event => setFilter(event.target.value as typeof filter)}>
    <Select.Option value="all">{t('dataAllEvents')}</Select.Option>
    {activityTopics.map(topic => <Select.Option key={topic} value={topic}>{t(titles[topic])}</Select.Option>)}
  </Select>} />
}
