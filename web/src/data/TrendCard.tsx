import {Stack} from '@primer/react'
import type {History, TrendTopic} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {DataCard, MetricValue} from './DataCard'
import {ColumnChart} from './ColumnChart'
import {dataHref, metricCategories} from './categories'
import {displayField, numeric, object} from './format'
import {metricNumber, metricValue, readings, startupVolume} from './metrics'
import type {TelemetryView} from './useTelemetry'

export function TrendCard({metric, telemetry, history}: {
  metric: TrendTopic
  telemetry: TelemetryView
  history: History
}) {
  const {t, locale} = useLanguage()
  const {category, icon, label} = metricCategories[metric]
  const connection = telemetry.connection
  const sample = metric === 'connection.quality' ? undefined : telemetry.samples[metric]
  const value = metric === 'connection.quality'
    ? connection.online ? numeric(connection.latencyMs) : undefined
    : metricNumber(metric, sample?.value)
  const current = value === undefined ? undefined : metricValue(metric, value, locale)
  const points = readings(metric, history[metric])
  const title = t(label)
  const resource = metric === 'disk' ? startupVolume(sample?.value) : metric === 'memory' ? object(sample?.value) : undefined
  const used = numeric(resource?.usedBytes)
  const total = numeric(resource?.totalBytes)
  let description: string | undefined
  if (used !== undefined && total !== undefined) {
    description = t('dataUsedOf', {used: displayField('usedBytes', used, locale, t), total: displayField('totalBytes', total, locale, t)})
  } else if (metric === 'connection.quality') {
    description = connection.protocol?.toUpperCase()
  } else if (metric === 'battery') {
    const battery = object(sample?.value)
    if (battery?.charging === true) description = t('dataCharging')
    else if (typeof battery?.externalPower === 'boolean') description = t(battery.externalPower ? 'dataPluggedIn' : 'dataOnBattery')
  }
  const onDemand = (metric === 'cpu' || metric === 'memory' || metric === 'disk' || metric === 'battery') &&
    object(telemetry.policy.data?.settings)?.[metric] === 0
  if (onDemand && !description) description = t('dataOnDemand')

  return <DataCard title={title} icon={icon} href={dataHref(category, {view: metric + '-readings'})}
    observedAt={metric === 'connection.quality' ? connection.lastCommunicationAt : sample?.observedAt}
    stale={sample && (sample.stale || !connection.online)} metric heading="h3">
    <Stack direction="horizontal" align="end" justify="space-between" gap="condensed">
      <MetricValue {...current} description={description} />
      <ColumnChart metric={metric} title={title} points={points} />
    </Stack>
  </DataCard>
}
