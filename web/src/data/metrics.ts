import type {DataValue, DeviceEvent, TrendTopic} from '../api/telemetry'
import type {Locale} from '../i18n'
import {decimal, numeric, object, records} from './format'

export interface Reading {
  id: string
  time: string
  value: number
}

export function startupVolume(value: DataValue | undefined) {
  const volumes = records(value)
  return volumes.find(item => item.mountPath === '/') ?? volumes[0]
}

export function metricNumber(metric: TrendTopic, value: DataValue | undefined): number | undefined {
  if (metric === 'disk') {
    const disk = startupVolume(value)
    const total = numeric(disk?.totalBytes)
    const used = numeric(disk?.usedBytes)
    return total && used !== undefined ? 100 * used / total : undefined
  }
  const sample = object(value)
  const name = metric === 'connection.quality' ? 'latencyMs' : metric === 'battery' ? 'chargePercent' : 'usagePercent'
  return numeric(sample?.[name])
}

export function readings(metric: TrendTopic, events: DeviceEvent[] = []): Reading[] {
  return events.flatMap(({sequence, time, payload}) => {
    const value = metricNumber(metric, payload)
    return value === undefined ? [] : [{id: sequence, time, value}]
  })
}

export function metricValue(metric: TrendTopic, value: number, locale: Locale) {
  return {amount: decimal(value, locale), unit: metric === 'connection.quality' ? 'ms' : '%'}
}
