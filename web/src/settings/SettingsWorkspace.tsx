import type {Device} from '../api/types'
import {useLanguage, type Message} from '../i18n'
import {Loading, Retry, State} from '../ui/Feedback'
import {ChannelSettings} from '../notifications/ChannelSettings'
import type {MaintenanceControl} from '../maintenance/useMaintenance'
import {DeviceSettings} from './DeviceSettings'
import {FileAccessSettings} from './FileAccessSettings'
import {GatewaySettings} from './GatewaySettings'
import {MaintenanceSettings} from './MaintenanceSettings'
import {PreferencesSettings} from './PreferencesSettings'
import {ProfileSettings} from './ProfileSettings'
import {ReportingSettings} from './ReportingSettings'
import {SettingsFrame} from './SettingsFrame'
import {SettingsPanel} from './SettingsPanel'
import {settingsHref, settingsLocation, type SettingsSection} from './settingsLocation'

const categoryGroups = [
  {label: 'settingsDevice', items: [
    ['general', 'settingsGeneral', 'settingsGeneralHelp'],
    ['reporting', 'settingsReporting', 'settingsReportingHelp'],
    ['fileAccess', 'settingsFileAccess', 'settingsFileAccessHelp'],
    ['maintenance', 'maintenanceTitle', 'maintenanceKeywords'],
  ]},
  {label: 'settingsManagement', items: [
    ['profiles', 'settingsProfiles', 'settingsProfilesHelp'],
    ['channels', 'notificationChannels', 'notificationChannelsHelp'],
    ['gateway', 'settingsGateway', 'settingsGatewayHelp'],
    ['preferences', 'settingsPreferences', 'settingsPreferencesHelp'],
  ]},
] as const satisfies readonly {label: Message; items: readonly (readonly [SettingsSection, Message, Message])[]}[]

export default function SettingsWorkspace({device, devices, hash, refresh, deviceError, devicesLoading, maintenance}: {
  device?: Device; devices: Device[]; hash: string; refresh: () => void; deviceError?: unknown; devicesLoading: boolean
  maintenance: MaintenanceControl
}) {
  const {t} = useLanguage()
  const {section, item} = settingsLocation(hash)
  const groups = categoryGroups.map(group => ({label: t(group.label), items: group.items.map(([id, label, keywords]) =>
    ({label: t(label), keywords: t(keywords), href: settingsHref(id), current: id === section}))}))

  let content
  switch (section) {
    case 'profiles': content = <ProfileSettings item={item} refresh={refresh} />; break
    case 'channels': content = <ChannelSettings item={item} />; break
    case 'gateway': content = <GatewaySettings item={item} devices={devices} />; break
    case 'preferences': content = <PreferencesSettings />; break
    default:
      if (!device) {
        const title = categoryGroups[0].items.find(([id]) => id === section)?.[1] ?? 'settingsGeneral'
        content = <SettingsPanel title={t(title)}>
          {deviceError ? <Retry error={deviceError} refresh={refresh} /> : devicesLoading ? <Loading /> :
            <State title={t('noDevices')} description={t('waitingDevice')} />}
        </SettingsPanel>
      } else if (section === 'reporting') content = <ReportingSettings key={device.id} device={device} refresh={refresh} />
      else if (section === 'fileAccess') content = <FileAccessSettings key={device.id} device={device} item={item} refreshDevice={refresh} />
      else if (section === 'maintenance') content = <MaintenanceSettings key={device.id} device={device} maintenance={maintenance} refreshDevice={refresh} />
      else content = <DeviceSettings key={device.id} device={device} refresh={refresh} />
  }

  return <SettingsFrame title={t('settings')} context={device && t('settingsOnDevice', {name: device.name})} groups={groups}
    storageKey="filesharing.settings-sidebar-width">{content}</SettingsFrame>
}
