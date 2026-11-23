import {Heading, Stack} from '@primer/react'
import {AppsIcon, DatabaseIcon, DeviceDesktopIcon, PulseIcon} from '@primer/octicons-react'
import {recentMinutes, trendTopics, type History} from '../api/telemetry'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {Timestamp} from '../ui/Timestamp'
import {DataCard, MetricValue} from './DataCard'
import {ColumnChart} from './ColumnChart'
import {TrendCard} from './TrendCard'
import {dataHref} from './categories'
import {codeLabel} from './dataFields'
import {decimal, displayField, elapsedStart, numeric, object, textValue} from './format'
import {readings} from './metrics'
import type {TelemetryView} from './useTelemetry'
import styles from './dashboard.module.css'

export function DataOverview({device, telemetry, history}: {device: Device; telemetry: TelemetryView; history: History}) {
  const {t, locale} = useLanguage()
  const {connection, samples} = telemetry
  const system = object(samples.system?.value)
  const sleep = textValue(system?.sleepState)
  const uptime = numeric(system?.uptimeSeconds)
  const boot = connection.online && !samples.system?.stale
    ? elapsedStart(system?.bootedAt, uptime, samples.system?.observedAt) : undefined
  const runtime = boot ? <Timestamp value={boot} variant="elapsed" />
    : uptime === undefined ? undefined : displayField('uptimeSeconds', uptime, locale, t)
  const protocol = connection.protocol?.toUpperCase()
  const latency = numeric(connection.latencyMs)
  const connectionDescription = [protocol, latency === undefined ? undefined : displayField('latencyMs', latency, locale, t)]
    .filter(Boolean).join(' · ')
  const inventories = [
    {topic: 'apps-running', label: 'dataRunning', icon: AppsIcon, href: dataHref('applications')},
    {topic: 'apps-installed', label: 'dataInstalled', icon: AppsIcon, href: dataHref('applications', {inventory: 'installed'})},
    {topic: 'storage', label: 'dataExternal', icon: DatabaseIcon, href: dataHref('storage', {view: 'external'})},
    {topic: 'disk', label: 'dataVolumes', icon: DatabaseIcon, href: dataHref('storage')},
  ] as const

  return <Stack gap="spacious">
    <div className={styles.grid}>
      <DataCard title={t('dataConnection')} icon={PulseIcon} href={dataHref('network', {view: 'connection'})}
        observedAt={connection.lastCommunicationAt} metric>
        <Stack direction="horizontal" align="end" justify="space-between" gap="condensed">
          <MetricValue amount={t(connection.online ? 'online' : 'offline')}
            description={connection.online ? connectionDescription : undefined} />
          <ColumnChart metric="connection.quality" title={t('dataLatency')}
            points={readings('connection.quality', history['connection.quality'])} />
        </Stack>
      </DataCard>
      <DataCard title={t('dataDeviceState')} icon={DeviceDesktopIcon} href={dataHref('device', {view: 'system'})}
        observedAt={samples.system?.observedAt} stale={samples.system && (samples.system.stale || !connection.online)} metric>
        <MetricValue amount={sleep ? codeLabel(sleep, locale) : undefined}
          description={<>{device.name}{runtime && <> · {runtime}</>}</>} />
      </DataCard>
    </div>
    <Stack as="section" gap="condensed">
      <Heading as="h2" className={styles.sectionTitle}>{t('dataTrends', {minutes: recentMinutes})}</Heading>
      <div className={styles.grid}>
        {trendTopics.filter(metric => metric !== 'connection.quality').map(metric =>
          <TrendCard key={metric} metric={metric} telemetry={telemetry} history={history} />)}
      </div>
    </Stack>
    <Stack as="section" gap="condensed">
      <Heading as="h2" className={styles.sectionTitle}>{t('dataInventory')}</Heading>
      <div className={styles.grid}>
        {inventories.map(({topic, label, icon, href}) => {
          const sample = samples[topic]
          const count = Array.isArray(sample?.value) ? decimal(sample.value.length, locale) : undefined
          return <DataCard key={topic} title={t(label)} icon={icon} heading="h3" href={href}
            observedAt={sample?.observedAt} stale={sample && (sample.stale || !connection.online)} metric>
            <MetricValue amount={count} />
          </DataCard>
        })}
      </div>
    </Stack>
  </Stack>
}
