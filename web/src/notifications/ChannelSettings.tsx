import {useState} from 'react'
import {Button, Link} from '@primer/react'
import {PlusIcon} from '@primer/octicons-react'
import {deleteChannel, readCatalog, readChannels, saveChannel} from '../api/notifications'
import type {NotificationChannel} from '../api/notificationTypes'
import {useLanguage} from '../i18n'
import {DeleteSetting} from '../settings/DeleteSetting'
import {SettingsRow, SettingsRows} from '../settings/SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from '../settings/SettingsPanel'
import {NEW_ITEM, settingsHref} from '../settings/settingsLocation'
import {BackButton} from '../ui/BackButton'
import {Loading, Retry} from '../ui/Feedback'
import {useRefresh, useResource, useTask} from '../ui/async'
import {ChannelActions} from './ChannelActions'
import {ChannelFields, providerName} from './ChannelFields'
import {NotificationEncryptionSetup} from './NotificationEncryptionSetup'
import {channelDraft, channelErrors, channelInput} from './channelDraft'
import {useNotificationUpdates} from './useNotificationUpdates'

export function ChannelSettings({item}: {item?: string}) {
  const {t} = useLanguage()
  const channels = useResource('channels', readChannels)
  const catalog = useResource('notification-catalog', readCatalog)
  const live = useNotificationUpdates(update => {
    if (!update || update.resource === 'channel') channels.refresh()
  })
  useRefresh(true, channels.refresh, live ? 30_000 : 8_000)
  const current = channels.data?.find(channel => channel.id === item)
  const vault = catalog.data?.credentialsEnabled
  useRefresh(vault === false, catalog.refresh, 15_000)
  if (vault !== undefined && (current || item === NEW_ITEM)) {
    return <ChannelEditor key={item} current={current} credentialsEnabled={vault} refresh={channels.refresh}
      encryptionConfigured={catalog.refresh} />
  }

  const error = channels.error ?? catalog.error
  return <SettingsPanel title={t('notificationChannels')} description={t('notificationChannelsHelp')}
    actions={<Button size="medium" leadingVisual={PlusIcon} disabled={!vault || !channels.data || channels.data.length >= (catalog.data?.maximumChannels ?? 0)}
      onClick={() => { window.location.hash = settingsHref('channels', NEW_ITEM) }}>{t('notificationAddChannel')}</Button>}>
    {error ? <Retry error={error} refresh={() => { channels.refresh(); catalog.refresh() }} /> :
      !channels.data || vault === undefined ? <Loading /> : <SettingsBand>
        {!vault && <NotificationEncryptionSetup onConfigured={catalog.refresh} />}
        {channels.data.length ? <SettingsRows>
          {channels.data.map(channel => <SettingsRow key={channel.id}
            title={<Link href={settingsHref('channels', channel.id)}>{channel.name}</Link>}
            description={providerName(channel.kind) + ' · ' + t(channel.enabled ? 'notificationEnabled' : 'notificationDisabled')}>{null}</SettingsRow>)}
        </SettingsRows> : <p>{t('notificationNoChannels')}</p>}
      </SettingsBand>}
  </SettingsPanel>
}

function ChannelEditor({current, credentialsEnabled, refresh, encryptionConfigured}: {
  current?: NotificationChannel; credentialsEnabled: boolean; refresh: () => void; encryptionConfigured: () => void
}) {
  const {t} = useLanguage()
  const [base, setBase] = useState(current)
  const [draft, setDraft] = useState(() => channelDraft(current))
  const [attempted, setAttempted] = useState(false)
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const dirty = !base || JSON.stringify(draft) !== JSON.stringify(channelDraft(base))
  const errors = channelErrors(draft, base)

  function show(channel: NotificationChannel) {
    setBase(channel)
    setDraft(channelDraft(channel))
    setAttempted(false)
  }

  return <SettingsPanel title={base?.name ?? t('notificationAddChannel')} description={t('notificationChannelsHelp')}
    actions={<BackButton to={settingsHref('channels')} destination={t('notificationChannels')} />}
    disabled={!dirty || (!base && !credentialsEnabled)} busy={task.busy} onApply={() => {
      setAttempted(true)
      if (Object.keys(errors).length || !draft.name.trim()) return
      void task.run(async signal => {
        show(await saveChannel(base?.id, channelInput(draft, base), signal))
        setSaved(true)
        refresh()
      })
    }}>
    <SettingsBand title={t('notificationChannelKind')}>
      {!credentialsEnabled && <NotificationEncryptionSetup onConfigured={encryptionConfigured} />}
      <ChannelFields draft={draft} change={setDraft} base={base} disabled={task.busy} errors={attempted ? errors : {}} />
      <SettingsNotice error={task.error} saved={saved && !dirty} reload={base && (() => void task.run(async signal => {
        const latest = (await readChannels(signal)).find(channel => channel.id === base.id)
        if (latest) show(latest)
        else window.location.hash = settingsHref('channels')
        setSaved(false)
      }))} />
    </SettingsBand>
    {base && <>
      <ChannelActions key={base.id + ':' + base.revision} channel={base} disabled={dirty || task.busy || !credentialsEnabled} />
      <SettingsBand title={t('settingsManagement')}>
        <SettingsRows>
          <SettingsRow title={t('notificationDeleteChannel')}>
            <DeleteSetting title={t('notificationDeleteChannel')} disabled={task.busy}
              description={t('notificationDeleteChannelHelp', {name: base.name})} remove={async signal => {
                await deleteChannel(base, signal)
                refresh()
                window.location.hash = settingsHref('channels')
              }} />
          </SettingsRow>
        </SettingsRows>
      </SettingsBand>
    </>}
  </SettingsPanel>
}
