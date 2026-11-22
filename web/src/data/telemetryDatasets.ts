import type {DataObject, History, SnapshotTopic, TrendTopic} from '../api/telemetry'
import type {Device} from '../api/types'
import type {Locale, Message, Translate} from '../i18n'
import {metricCategories} from './categories'
import {fullTimestamp, object} from './format'
import {metricValue, readings} from './metrics'
import {cell, objectDataset, type ReadingDataset} from './readingModel'
import type {TelemetryView} from './useTelemetry'

export interface ReadingContext {
  device: Device
  telemetry: TelemetryView
  history: History
  locale: Locale
  t: Translate
}

export function sampleDataset(topic: SnapshotTopic, title: Message, {telemetry, locale, t}: ReadingContext) {
  const sample = telemetry.samples[topic]
  return objectDataset(topic, t(title), object(sample?.value), locale, t, sample)
}

export function historyDataset(metric: TrendTopic, {history, locale, t}: ReadingContext): ReadingDataset {
  const points = readings(metric, history[metric])
  return {
    key: metric + '-readings',
    title: t('dataMetricReadings', {metric: t(metricCategories[metric].label)}),
    nameTitle: t('dataTime'),
    columns: [{key: 'value', title: t('dataValue')}],
    rows: points.map(point => {
      const value = metricValue(metric, point.value, locale)
      return {id: point.id, name: cell(fullTimestamp(point.time, locale), Date.parse(point.time)),
        values: {value: cell(value.amount + ' ' + value.unit, point.value)}}
    }),
    snapshot: {observedAt: points.at(-1)?.time ?? null, stale: false},
    sort: {key: 'name', direction: 'desc'},
    empty: t('dataNoReadings'),
  }
}

export function deviceDatasets(context: ReadingContext) {
  const {telemetry, device, locale, t} = context
  const identity = telemetry.samples.identity
  const info: DataObject = {name: device.name, ...object(identity?.value), deviceId: device.id,
    profileId: device.profileId ?? null, createdAt: device.createdAt ?? null, revision: device.revision ?? null}
  return [
    objectDataset('identity', t('dataIdentity'), info, locale, t, identity),
    sampleDataset('system', 'dataDeviceState', context),
    sampleDataset('agent', 'dataAgent', context),
    sampleDataset('displays', 'dataDisplays', context),
    sampleDataset('locale', 'dataLocale', context),
    {...objectDataset('policy', t('dataPolicy'), telemetry.policy.data, locale, t), pending: telemetry.policy.pending},
  ]
}

export function performanceDatasets(context: ReadingContext) {
  const {telemetry, locale, t} = context
  const {cpu, memory} = telemetry.samples
  const metrics: DataObject = {}
  if (cpu) metrics.cpu = cpu.value
  if (memory) metrics.memory = memory.value
  const observedAt = [cpu?.observedAt, memory?.observedAt].flatMap(time => time ? [time] : []).sort().at(-1) ?? null
  const current = objectDataset('performance', t('dataPerformance'), metrics, locale, t,
    {observedAt, stale: Boolean(cpu?.stale || memory?.stale)})
  return [current, historyDataset('cpu', context), historyDataset('memory', context)]
}

export function powerDatasets(context: ReadingContext) {
  return [sampleDataset('power', 'dataPower', context), sampleDataset('battery', 'dataBattery', context),
    sampleDataset('lid', 'dataLid', context), historyDataset('battery', context)]
}
