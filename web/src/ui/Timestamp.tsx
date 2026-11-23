import {RelativeTime} from '@primer/react'
import {useLanguage} from '../i18n'

const clock = {hour: '2-digit', minute: '2-digit'} as const
const calendar = {year: 'numeric', month: 'short', day: 'numeric', ...clock} as const
const formats = {
  file: {format: 'relative', threshold: 'PT1H', ...calendar},
  recent: {format: 'relative', threshold: 'PT24H', ...calendar},
  exact: {format: 'datetime', ...calendar, weekday: 'long', month: 'long', second: '2-digit', timeZoneName: 'shortOffset'},
  clock: {format: 'datetime', ...clock, weekday: undefined, year: undefined, month: undefined, day: undefined},
  elapsed: {format: 'duration', formatStyle: 'short', precision: 'second', tense: 'past'},
} as const

export function timestampEpoch(value: string | null | undefined) {
  const epoch = value ? Date.parse(value) : NaN
  return Number.isFinite(epoch) ? epoch : undefined
}

export function Timestamp({value, variant = 'recent'}: {value?: string | null; variant?: keyof typeof formats}) {
  const {locale, t} = useLanguage()
  if (!value || timestampEpoch(value) === undefined) return t('missing')
  return <RelativeTime datetime={value} lang={locale} hour-cycle="h23" prefix="" noTitle {...formats[variant]} />
}
