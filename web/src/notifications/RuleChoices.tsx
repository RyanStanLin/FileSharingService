import {Link} from '@primer/react'
import type {NotificationCatalog, NotificationChannel} from '../api/notificationTypes'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {SettingsRow, SettingsRows, SettingsSwitch, SettingsText} from '../settings/SettingsFields'
import {SettingsMultiChoice} from '../settings/SettingsMultiChoice'
import {SettingsBand} from '../settings/SettingsPanel'
import {settingsHref} from '../settings/settingsLocation'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {providerName} from './ChannelFields'
import {eventGroup, eventGroupName, eventName} from './notificationLabels'
import {RuleAuthorization} from './RuleRuntime'
import type {RuleDraft} from './ruleDraft'

interface Props {
  draft: RuleDraft
  devices: Device[]
  channels: NotificationChannel[]
  catalog: NotificationCatalog
  disabled: boolean
  attempted: boolean
  change: (patch: Partial<RuleDraft>) => void
  refresh: () => void
}

export function RuleChoices({draft, devices, channels, catalog, disabled, attempted, change, refresh}: Props) {
  const {t, locale} = useLanguage()
  const device = devices.find(item => item.id === draft.deviceId)
  const deviceOptions = devices.map(item => ({value: item.id, label: item.name}))
  if (!device && draft.deviceId) deviceOptions.unshift({value: draft.deviceId, label: draft.deviceId})
  const eventGroups = Array.from(new Set(catalog.events.map(type => eventGroup(type.type))))
    .map(groupId => ({groupId, header: eventGroupName(groupId, locale)}))
  const eventOptions = catalog.events.map(type => ({id: type.type, text: eventName(type.type, locale),
    description: type.type, groupId: eventGroup(type.type)}))
  const channelOptions = channels.map(channel => ({
    id: channel.id, text: channel.name,
    description: providerName(channel.kind) + ' · ' + t(channel.enabled ? 'notificationEnabled' : 'notificationDisabled'),
  }))
  return <SettingsBand title={t('notificationGroup')}>
    <SettingsText label={t('notificationRuleName')} value={draft.name} onChange={event => change({name: event.target.value})}
      required maxLength={120} disabled={disabled} />
    <SettingsRows>
      <SettingsSwitch title={t('notificationRuleEnabled')} checked={draft.enabled} onChange={enabled => change({enabled})}
        disabled={disabled} />
      <SettingsRow title={t('notificationRuleDevice')}
        description={attempted && !device ? <span role="alert">{t('settingsRequired')}</span> : device ? t(device.connection.online ? 'online' : 'offline') : t('noDevices')}>
        <ChoiceMenu label={t('notificationRuleDevice')} value={draft.deviceId} options={deviceOptions} disabled={disabled || !devices.length}
          onChange={deviceId => change({deviceId, rootId: '', path: ''})} />
      </SettingsRow>
      {device && <RuleAuthorization key={device.id} device={device} refresh={refresh} />}
      <SettingsRow title={t('notificationEvents')} description={attempted && !draft.events.length && <span role="alert">{t('settingsRequired')}</span>}>
        <SettingsMultiChoice label={t('notificationChooseEvents')} value={draft.events} items={eventOptions} groups={eventGroups}
          change={events => change({events})} max={16} disabled={disabled} />
      </SettingsRow>
      <SettingsRow title={t('notificationChannels')} description={
        !channels.length ? <Link href={settingsHref('channels')}>{t('notificationAddChannel')}</Link> :
          attempted && !draft.channelIds.length ? <span role="alert">{t('settingsRequired')}</span> : undefined
      }>
        <SettingsMultiChoice label={t('notificationChooseChannels')} value={draft.channelIds} items={channelOptions}
          change={channelIds => change({channelIds})} max={catalog.maximumChannelsPerRule} disabled={disabled || !channels.length} />
      </SettingsRow>
    </SettingsRows>
  </SettingsBand>
}
