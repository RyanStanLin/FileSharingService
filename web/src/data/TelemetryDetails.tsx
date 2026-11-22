import {Stack} from '@primer/react'
import {DatabaseIcon, DeviceDesktopIcon, GlobeIcon, PlugIcon, PulseIcon, ShieldIcon} from '@primer/octicons-react'
import {readAll} from '../api/client'
import {deviceRoute} from '../api/devices'
import type {DataObject, History} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {DataCard} from './DataCard'
import {DataFacts} from './DataFacts'
import {SnapshotCard} from './SnapshotCard'
import {TrendCard} from './TrendCard'
import {object, records} from './format'
import type {TelemetryView} from './useTelemetry'
import styles from './dashboard.module.css'
import detailStyles from './details.module.css'

interface DetailsProps {
  telemetry: TelemetryView
  history: History
}

function Inventory({items}: {items: DataObject[]}) {
  const {t} = useLanguage()
  if (!items.length) return <p className={detailStyles.muted}>{t('dataEmptyList')}</p>
  return <ul className={detailStyles.inventory}>
    {items.map((item, index) => <li key={String(item.id ?? item.mountPath ?? item.rootKey ?? index)}>
      <DataFacts value={item} />
    </li>)}
  </ul>
}

export function PerformanceDetails({telemetry, history}: DetailsProps) {
  return <div className={styles.grid}>
    <TrendCard telemetry={telemetry} history={history} metric="cpu" detail />
    <TrendCard telemetry={telemetry} history={history} metric="memory" detail />
  </div>
}

export function PowerDetails({telemetry, history}: DetailsProps) {
  return <div className={styles.grid}>
    <TrendCard telemetry={telemetry} history={history} metric="battery" detail />
    <SnapshotCard telemetry={telemetry} topic="power" label="dataPower" icon={PlugIcon} tone="green" />
    <SnapshotCard telemetry={telemetry} topic="lid" label="dataLid" icon={DeviceDesktopIcon} tone="purple" />
  </div>
}

export function NetworkDetails({telemetry, history}: DetailsProps) {
  const {t} = useLanguage()
  const network = object(telemetry.samples.network?.value)
  const {interfaces, ...settings} = network ?? {}
  const connection = Object.fromEntries(Object.entries(telemetry.connection)) as DataObject
  return <Stack gap="normal">
    <div className={styles.grid}>
      <DataCard title={t('dataConnection')} icon={PulseIcon} tone="blue" observedAt={telemetry.connection.lastCommunicationAt}>
        <DataFacts value={connection} />
      </DataCard>
      <TrendCard telemetry={telemetry} history={history} metric="connection.quality" detail />
      <SnapshotCard telemetry={telemetry} topic="network" label="dataNetwork" icon={GlobeIcon} tone="blue" value={settings} />
    </div>
    <SnapshotCard telemetry={telemetry} topic="network" label="dataInterfaces" icon={GlobeIcon} tone="blue">
      {network ? <Inventory items={records(interfaces)} /> : <DataFacts />}
    </SnapshotCard>
  </Stack>
}

export function StorageDetails({telemetry, history}: DetailsProps) {
  return <Stack gap="normal">
    <div className={styles.grid}>
      <TrendCard telemetry={telemetry} history={history} metric="disk" detail />
      <SnapshotCard telemetry={telemetry} topic="storage" label="dataExternal" icon={DatabaseIcon} tone="purple">
        {telemetry.samples.storage ? <Inventory items={records(telemetry.samples.storage.value)} /> : <DataFacts />}
      </SnapshotCard>
    </div>
    <SnapshotCard telemetry={telemetry} topic="disk" label="dataVolumes" icon={DatabaseIcon} tone="blue">
      {telemetry.samples.disk ? <Inventory items={records(telemetry.samples.disk.value)} /> : <DataFacts />}
    </SnapshotCard>
  </Stack>
}

export function PermissionDetails({telemetry, deviceId}: {telemetry: TelemetryView; deviceId: string}) {
  const {t} = useLanguage()
  const grants = useResource(deviceId, signal => readAll<DataObject>(deviceRoute(deviceId) + '/file-roots', signal))
  useRefresh(!grants.pending, grants.refresh, 20_000)
  return <div className={styles.grid}>
    <SnapshotCard telemetry={telemetry} topic="permissions" label="dataPermissionState" icon={ShieldIcon} tone="green" />
    <SnapshotCard telemetry={telemetry} topic="roots" label="dataLocalRoots" icon={ShieldIcon} tone="green">
      {telemetry.samples.roots ? <Inventory items={records(telemetry.samples.roots.value)} /> : <DataFacts />}
    </SnapshotCard>
    <DataCard title={t('dataServerRoots')} icon={ShieldIcon} tone="blue">
      {grants.pending && !grants.data ? <Loading /> : <Inventory items={grants.data ?? []} />}
      <ErrorText error={grants.error} />
    </DataCard>
  </div>
}
