import {useId} from 'react'
import type {TrendTopic} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {Timestamp, timestampEpoch} from '../ui/Timestamp'
import {metricValue, type Reading} from './metrics'
import styles from './dashboard.module.css'

export function ColumnChart({title, metric, points}: {title: string; metric: TrendTopic; points: Reading[]}) {
  const {locale, t} = useLanguage()
  const times = useId()
  const recent = points.slice(-9)
  const first = recent[0]?.time
  const last = recent.at(-1)?.time
  const firstEpoch = timestampEpoch(first)
  const lastEpoch = timestampEpoch(last)
  if (firstEpoch === undefined || lastEpoch === undefined) return null
  const sameMinute = Math.floor(firstEpoch / 60_000) === Math.floor(lastEpoch / 60_000)
  const ceiling = metric === 'connection.quality'
    ? Math.max(10, Math.ceil(Math.max(...recent.map(point => point.value)) / 10) * 10)
    : 100
  const axis = metricValue(metric, ceiling, locale)
  const width = 96
  const height = 44
  const step = 10

  return <figure className={styles.chart}>
    <span className={styles.chartAxis}>{axis.amount} {axis.unit}</span>
    <svg viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={t('dataBarChart', {title, count: recent.length})} aria-describedby={times}>
      <line className={styles.chartBaseline} x1="0" x2={width} y1={height - 1} y2={height - 1} />
      {recent.map((point, index) => {
        const bar = Math.max(1, Math.min(height - 2, point.value / ceiling * (height - 2)))
        const value = metricValue(metric, point.value, locale)
        return <rect className={index === recent.length - 1 ? styles.latestBar : styles.bar} key={point.id}
          x={width - (recent.length - index) * step} y={height - 1 - bar} width="7" height={bar} rx="1">
          <title>{value.amount} {value.unit}</title>
        </rect>
      })}
    </svg>
    <figcaption id={times} className={styles.chartTimes}>
      <span>{!sameMinute && <Timestamp value={first} variant="clock" />}</span>
      <span><Timestamp value={last} variant="clock" /></span>
    </figcaption>
  </figure>
}
