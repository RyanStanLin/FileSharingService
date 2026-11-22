import {Stack} from '@primer/react'
import {BrowserIcon, DeviceDesktopIcon, GlobeIcon, MeterIcon, PulseIcon, ServerIcon} from '@primer/octicons-react'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {DataCard} from './DataCard'
import {DataFacts} from './DataFacts'
import {SnapshotCard} from './SnapshotCard'
import {object} from './format'
import type {TelemetryView} from './useTelemetry'
import styles from './dashboard.module.css'

export function DeviceDetails({device, telemetry}: {device: Device; telemetry: TelemetryView}) {
  const {t} = useLanguage()
  const {policy} = telemetry
  const identity = {
    name: device.name,
    ...object(telemetry.samples.identity?.value),
    deviceId: device.id,
    profileId: device.profileId ?? null,
    createdAt: device.createdAt ?? null,
    revision: device.revision ?? null,
  }
  return <div className={styles.grid}>
    <SnapshotCard telemetry={telemetry} topic="identity" label="dataIdentity" icon={DeviceDesktopIcon} tone="purple" value={identity} />
    <SnapshotCard telemetry={telemetry} topic="system" label="dataDeviceState" icon={PulseIcon} tone="blue" />
    <SnapshotCard telemetry={telemetry} topic="agent" label="dataAgent" icon={ServerIcon} tone="purple" />
    <SnapshotCard telemetry={telemetry} topic="displays" label="dataDisplays" icon={BrowserIcon} tone="blue" />
    <SnapshotCard telemetry={telemetry} topic="locale" label="dataLocale" icon={GlobeIcon} tone="blue" />
    <DataCard title={t('dataPolicy')} icon={MeterIcon} tone="orange">
      <Stack gap="condensed">
        {policy.pending && !policy.data ? <Loading /> : <DataFacts value={policy.data} />}
        <ErrorText error={policy.error} />
      </Stack>
    </DataCard>
  </div>
}
