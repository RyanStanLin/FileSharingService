import type {Entry} from '../api/types'
import type {Locale, Translate} from './index'

export function number(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale).format(value)
}

export function bytes(value: number, locale: Locale) {
  const unit = value >= 2 ** 30 ? 'gigabyte' : value >= 2 ** 20 ? 'megabyte' : value >= 2 ** 10 ? 'kilobyte' : 'byte'
  const exponent = {byte: 0, kilobyte: 10, megabyte: 20, gigabyte: 30}[unit]
  return new Intl.NumberFormat(locale, {
    style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1,
  }).format(value / 2 ** exponent)
}

export function duration(seconds: number, locale: Locale) {
  const whole = Math.max(0, Math.floor(seconds))
  const amount = (value: number, unit: string) => new Intl.NumberFormat(locale, {
    style: 'unit', unit, unitDisplay: 'narrow',
  }).format(value)
  const parts = whole >= 3600 ? [amount(Math.floor(whole / 3600), 'hour')] : []
  if (whole >= 60) parts.push(amount(Math.floor((whole % 3600) / 60), 'minute'))
  if (whole < 3600) parts.push(amount(whole % 60, 'second'))
  return parts.join(' ')
}

export function entryKind(entry: Entry, t: Translate) {
  if (entry.kind === 'directory') return t('folder')
  if (entry.kind === 'symlink') return t('link')
  const known = {pdf: 'pdf', png: 'png', jpeg: 'jpeg', jpg: 'jpeg', key: 'keynote'} as const
  const extension = entry.extension?.toLowerCase()
  if (extension && Object.hasOwn(known, extension)) return t(known[extension as keyof typeof known])
  if (entry.thumbnail === 'image') return t('image')
  return extension?.toUpperCase() || t('file')
}
