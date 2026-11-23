import {useMemo} from 'react'
import {HistoryIcon} from '@primer/octicons-react'
import {activityTopics, recentMinutes, type ActivityTopic, type History} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {ReadingPane, type ReadingChrome} from './ReadingPane'
import {codeLabel} from './dataFields'
import {eventCategories, type EventView} from './eventViews'
import {object, textValue} from './format'
import {cell, valueCell, type ReadingRow} from './readingModel'
import {useClipboardHistory} from './useClipboardHistory'

export function ActivityList({deviceId, eventView, newestClipboard, streaming, history, historyReady, pending, chrome}: {
  deviceId: string
  eventView: EventView
  newestClipboard?: string
  streaming: boolean
  history: History
  historyReady: boolean
  pending: boolean
  chrome: ReadingChrome
}) {
  const {t, locale} = useLanguage()
  const isClipboard = eventView === 'clipboard.changed'
  const clipboard = useClipboardHistory({deviceId: isClipboard ? deviceId : null, newestEvent: newestClipboard, streaming, chrome})
  const events = useMemo(() => eventView === 'all' ? activityTopics.flatMap(topic => history[topic] ?? []) : history[eventView] ?? [],
    [eventView, history])
  const rows = useMemo<ReadingRow[]>(() => events.map(event => {
    const payload = object(event.payload)
    const time = textValue(payload?.occurredAt) ?? event.time
    const kind = textValue(payload?.kind)
    const state = textValue(payload?.state)
    const record = object(payload?.application ?? payload?.storage)
    const name = textValue(record?.name ?? record?.mountPath ?? record?.id)
    const presence = typeof payload?.online === 'boolean' ? t(payload.online ? 'online' : 'offline') : undefined
    const detail = [kind ? codeLabel(kind, locale) : undefined, state ? codeLabel(state, locale) : presence, name]
      .filter(Boolean).join(' · ')
    return {id: event.sequence, name: cell(t(eventCategories[event.topic as ActivityTopic].label)), icon: <HistoryIcon />,
      values: {time: valueCell('occurredAt', time, locale, t), information: cell(detail || t('missing'))},
      value: {...(event.topic === 'clipboard.changed' ? {} : payload), occurredAt: time, recordedAt: event.time}}
  }), [events, locale, t])

  if (isClipboard) return <ReadingPane {...clipboard} />

  const observedAt = events.reduce<string | null>((latest, event) =>
    !latest || Date.parse(event.time) > Date.parse(latest) ? event.time : latest, null)
  return <ReadingPane chrome={chrome} eventHistoryReady={historyReady} dataset={{
    key: eventView === 'all' ? 'events' : eventView,
    title: t(eventView === 'all' ? 'dataEvents' : eventCategories[eventView].label),
    nameTitle: t('dataEventKind'), description: t('dataWindow', {minutes: recentMinutes}),
    columns: [{key: 'time', title: t('dataTime')}, {key: 'information', title: t('dataDescription')}],
    rows, icons: true, details: true, sort: {key: 'time', direction: 'desc'}, empty: t('dataNoEvents'), pending,
    snapshot: {observedAt, stale: false},
  }} />
}
