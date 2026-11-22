import type {TrendTopic} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {fullTimestamp, timestamp} from './format'
import {metricValue, type Reading} from './metrics'
import styles from './dashboard.module.css'

export function ColumnChart({title, metric, points}: {title: string; metric: TrendTopic; points: Reading[]}) {
  const {locale, t} = useLanguage()
  const recent = points.slice(-9)
  const first = timestamp(recent[0]?.time, locale, true)
  const last = timestamp(recent.at(-1)?.time, locale, true)
  if (!recent.length || !first || !last) return null
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
      aria-label={t('dataBarChart', {title, count: recent.length, first, last})}>
      <line className={styles.chartBaseline} x1="0" x2={width} y1={height - 1} y2={height - 1} />
      {recent.map((point, index) => {
        const bar = Math.max(1, Math.min(height - 2, point.value / ceiling * (height - 2)))
        const value = metricValue(metric, point.value, locale)
        return <rect className={index === recent.length - 1 ? styles.latestBar : styles.bar} key={point.id}
          x={width - (recent.length - index) * step} y={height - 1 - bar} width="7" height={bar} rx="1">
          <title>{fullTimestamp(point.time, locale)} · {value.amount} {value.unit}</title>
        </rect>
      })}
    </svg>
    <figcaption className={styles.chartTimes}><span>{first === last ? '' : first}</span><span>{last}</span></figcaption>
  </figure>
}
