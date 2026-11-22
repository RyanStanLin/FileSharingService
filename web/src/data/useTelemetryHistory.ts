import {useEffect, useMemo, useRef} from 'react'
import {ApiError} from '../api/client'
import {activityTopics, readHistoryPage, recentSince, trendTopics, type DeviceEvent, type History, type HistoryTopic} from '../api/telemetry'
import {useRefresh, useResource} from '../ui/async'
import {laterSequence} from './useTelemetryStream'

async function readHistory(device: string, topic: HistoryTopic, from: string, signal: AbortSignal) {
  const items: DeviceEvent[] = []
  let cursor: string | undefined
  while (true) {
    const page = await readHistoryPage(device, topic, from, signal, cursor)
    items.push(...page.items)
    if (!page.hasMore || cursor === page.cursor) return items
    cursor = page.cursor
  }
}

async function loadHistory(device: string, topics: readonly HistoryTopic[], signal: AbortSignal) {
  const from = recentSince()
  const history: History = {}
  const results = await Promise.allSettled(topics.map(async topic => {
    try {
      history[topic] = await readHistory(device, topic, from, signal)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'resync_required')) throw error
      history[topic] = await readHistory(device, topic, from, signal)
    }
  }))
  const error = results.find(result => result.status === 'rejected')?.reason
  return {history, error}
}

function mergeHistory(sources: History[]) {
  const history: History = {}
  const from = Date.parse(recentSince())
  for (const topic of [...trendTopics, ...activityTopics]) {
    const events = new Map<string, DeviceEvent>()
    for (const source of sources) {
      for (const item of source[topic] ?? []) {
        if (Date.parse(item.time) >= from) events.set(item.sequence, item)
      }
    }
    if (events.size) history[topic] = [...events.values()].sort((a, b) => laterSequence(a.sequence, b.sequence) ? 1 : -1)
  }
  return history
}

export function useTelemetryHistory(device: string, live: History, streaming: boolean, showActivity: boolean) {
  const trends = useResource(device, signal => loadHistory(device, trendTopics, signal))
  const activity = useResource(showActivity ? device : null, signal => loadHistory(device, activityTopics, signal))
  const initialized = useRef(false)
  useEffect(() => {
    if (streaming) {
      if (initialized.current) {
        trends.refresh()
        activity.refresh()
      }
      initialized.current = true
    }
  }, [streaming, trends.refresh, activity.refresh])
  useRefresh(!streaming && !trends.pending, trends.refresh, 15_000, false)
  useRefresh(!streaming && showActivity && !activity.pending, activity.refresh, 15_000, false)
  const history = useMemo(() => mergeHistory([trends.data?.history ?? {}, activity.data?.history ?? {}, live]),
    [trends.data, activity.data, live])
  return {history, trends, activity}
}
