import {useState} from 'react'
import {Button, FormControl, Select, Stack} from '@primer/react'
import {HistoryIcon} from '@primer/octicons-react'
import {activityTopics, recentMinutes, type ActivityTopic, type DeviceEvent, type History} from '../api/telemetry'
import {useLanguage, type Message} from '../i18n'
import {Loading} from '../ui/Feedback'
import {DataCard} from './DataCard'
import {RecordDialog, RecordPager, useRecordPage} from './RecordList'
import {codeLabel} from './dataFields'
import {decimal, fullTimestamp, object, textValue} from './format'
import {laterSequence} from './useTelemetryStream'
import styles from './details.module.css'

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

export function ActivityList({history, pending}: {history: History; pending: boolean}) {
  const {t, locale} = useLanguage()
  const [filter, setFilter] = useState<ActivityTopic | 'all'>('all')
  const [selected, setSelected] = useState<DeviceEvent>()
  const events = (filter === 'all' ? activityTopics.flatMap(topic => history[topic] ?? []) : [...(history[filter] ?? [])])
    .sort((a, b) => laterSequence(b.sequence, a.sequence) ? 1 : -1)
  const pager = useRecordPage(events)

  function describe(event: DeviceEvent) {
    const payload = object(event.payload)
    const time = textValue(payload?.occurredAt) ?? event.time
    const kind = textValue(payload?.kind)
    const state = textValue(payload?.state)
    const record = object(payload?.application ?? payload?.storage)
    const name = textValue(record?.name ?? record?.mountPath ?? record?.id)
    const presence = typeof payload?.online === 'boolean' ? t(payload.online ? 'online' : 'offline') : undefined
    const detail = [kind ? codeLabel(kind, locale) : undefined, state ? codeLabel(state, locale) : presence, name]
      .filter(Boolean).join(' · ')
    return {time, title: t(titles[event.topic as ActivityTopic]), detail, payload}
  }

  const info = selected && describe(selected)
  return <DataCard title={t('dataWindow', {minutes: recentMinutes})} tone="orange" icon={HistoryIcon}>
    <Stack gap="normal">
      <Stack direction="horizontal" align="end" justify="space-between" gap="condensed" wrap="wrap">
        <FormControl>
          <FormControl.Label>{t('dataEventKind')}</FormControl.Label>
          <Select size="medium" value={filter} onChange={event => {
            setFilter(event.target.value as typeof filter)
            pager.setPage(1)
          }}>
            <Select.Option value="all">{t('dataAllEvents')}</Select.Option>
            {activityTopics.map(topic => <Select.Option key={topic} value={topic}>{t(titles[topic])}</Select.Option>)}
          </Select>
        </FormControl>
        <span className={styles.muted}>{t(events.length === 1 ? 'dataResultOne' : 'dataResultCount',
          {count: decimal(events.length, locale)})}</span>
      </Stack>
      {pager.rows.length ? <ul className={styles.records}>
        {pager.rows.map(event => {
          const row = describe(event)
          return <li key={event.sequence}>
            <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" wrap="wrap">
              <Stack gap="none" className={styles.recordInfo}>
                <Button variant="invisible" size="medium" className={styles.recordButton} onClick={() => setSelected(event)}>{row.title}</Button>
                {row.detail && <span className={styles.muted}>{row.detail}</span>}
              </Stack>
              <time dateTime={row.time} className={styles.recordMeta}>{fullTimestamp(row.time, locale)}</time>
            </Stack>
          </li>
        })}
      </ul> : pending ? <Loading /> : <p className={styles.muted}>{t('dataNoEvents')}</p>}
      <RecordPager {...pager} />
    </Stack>
    {selected && info && <RecordDialog title={info.title} close={() => setSelected(undefined)}
      value={selected.topic === 'clipboard.changed' ? {occurredAt: info.time}
        : {...info.payload, occurredAt: info.time}} />}
  </DataCard>
}
