import type {DataObject, DataValue} from '../api/telemetry'
import type {Locale, Translate} from '../i18n'
import {duration} from '../i18n/format'
import {timestampEpoch} from '../ui/Timestamp'
import {codeLabel} from './dataFields'

type OptionalValue = DataValue | undefined

export function object(value: OptionalValue): DataObject | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

export function records(value: OptionalValue): DataObject[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is DataObject => object(entry) != null)
}

export function numeric(value: OptionalValue) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function textValue(value: OptionalValue) {
  return typeof value === 'string' && value ? value : undefined
}

export function elapsedStart(startedAt: OptionalValue, uptime: OptionalValue, observedAt?: string | null) {
  const start = textValue(startedAt)
  if (timestampEpoch(start) !== undefined) return start
  const observed = timestampEpoch(observedAt)
  const seconds = numeric(uptime)
  if (observed === undefined || seconds === undefined || seconds < 0) return undefined
  const inferred = new Date(observed - seconds * 1000)
  if (Number.isFinite(inferred.getTime())) return inferred.toISOString()
}

export function decimal(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {maximumFractionDigits: 1}).format(value)
}

export function volume(value: number, locale: Locale) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const scale = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))))
  return {amount: decimal(value / 1024 ** scale, locale), unit: units[scale]}
}

function unitAmount(value: number, unit: string, locale: Locale) {
  return new Intl.NumberFormat(locale, {style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1}).format(value)
}

export function displayField(name: string, value: OptionalValue, locale: Locale, t: Translate, parent?: string) {
  if (value == null) return t('missing')
  if (typeof value === 'boolean') return t(value ? 'dataYes' : 'dataNo')
  if (typeof value === 'number') {
    if (/(Bytes|^offset$|^length$)/.test(name)) {
      const size = volume(value, locale)
      return size.amount + ' ' + size.unit
    }
    if (name.endsWith('Seconds')) return duration(value, locale)
    if (name.endsWith('Percent')) return new Intl.NumberFormat(locale, {style: 'percent', maximumFractionDigits: 1}).format(value / 100)
    if (name.endsWith('Ms')) return unitAmount(value, 'millisecond', locale)
    if (name.endsWith('Hz')) return decimal(value, locale) + ' Hz'
    if (parent === 'settings') return unitAmount(value, 'second', locale)
    return decimal(value, locale)
  }
  if (typeof value === 'string') {
    if (name === 'protocol') return value.toUpperCase()
    return ['kind', 'state', 'status', 'phase', 'lockState', 'lockStateQuality', 'sleepState', 'reachability',
      'health', 'displayAndLockPolicy'].includes(name) ? codeLabel(value, locale) : value || t('missing')
  }
  return t('missing')
}
