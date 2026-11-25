import {useEffect, useState} from 'react'
import {Button, Link} from '@primer/react'
import {PlusIcon} from '@primer/octicons-react'
import {readCatalog, readChannels, readRules} from '../api/notifications'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {SettingsRow, SettingsRows} from '../settings/SettingsFields'
import {SettingsFrame} from '../settings/SettingsFrame'
import {SettingsBand, SettingsPanel} from '../settings/SettingsPanel'
import {NEW_ITEM, settingsHref, subscriptionHref} from '../settings/settingsLocation'
import {Loading, Retry} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {RuleEditor} from './RuleEditor'
import {useNotificationUpdates} from './useNotificationUpdates'

export default function SubscriptionsWorkspace({devices, device, hash, refreshDevices}: {
  devices: Device[]; device?: Device; hash: string; refreshDevices: () => void
}) {
  const {t} = useLanguage()
  const id = new URLSearchParams(hash.split('?')[1]).get('rule')
  const rules = useResource('rules', readRules)
  const channels = useResource('channels', readChannels)
  const catalog = useResource('catalog', readCatalog)
  const live = useNotificationUpdates(update => {
    if (!update || update.resource === 'rule') rules.refresh()
    if (!update || update.resource === 'channel') channels.refresh()
  })
  useRefresh(true, rules.refresh, live ? 12_000 : 8000)
  useRefresh(!live, channels.refresh, 20_000)
  const entries = [...(rules.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [created, setCreated] = useState<string>()
  const selected = entries.find(rule => rule.id === id)
  useEffect(() => {
    if (id === NEW_ITEM && created && rules.data?.some(rule => rule.id === created)) {
      window.location.replace(subscriptionHref(created))
    }
  }, [created, id, rules.data])
  const label = (deviceId: string) => devices.find(item => item.id === deviceId)?.name ?? deviceId
  const groups = [{label: t('subscriptions'), items: [{
    label: t('notificationAllRules'), href: subscriptionHref(), current: !selected && id !== NEW_ITEM,
  }]}, ...[true, false].map(enabled => ({
    label: t(enabled ? 'notificationEnabled' : 'notificationDisabled'),
    items: entries.filter(rule => rule.enabled === enabled).map(rule => ({
      label: rule.name, href: subscriptionHref(rule.id), current: selected?.id === rule.id, keywords: label(rule.deviceId),
    })),
  }))]
  const error = rules.error ?? channels.error ?? catalog.error
  const ready = !!rules.data && !!channels.data && !!catalog.data
  const editor = (selected || id === NEW_ITEM) && ready
  const create = <Button size="medium" leadingVisual={PlusIcon} disabled={!ready || !devices.length || !channels.data?.length ||
    entries.length >= (catalog.data?.maximumRules ?? 0)}
    onClick={() => { setCreated(undefined); window.location.hash = subscriptionHref(NEW_ITEM) }}>{t('notificationNewRule')}</Button>

  return <SettingsFrame title={t('subscriptions')} groups={groups} storageKey="filesharing.subscription-sidebar-width">
    {editor ? <RuleEditor key={id} rule={selected} device={device ?? devices[0]}
      devices={devices} channels={channels.data!} catalog={catalog.data!} refresh={rules.refresh} refreshDevices={refreshDevices}
      created={!!selected && selected.id === created} onCreated={setCreated} /> :
      <SettingsPanel title={t('subscriptions')} description={t('notificationRulesHelp')} actions={create}>
        {error ? <Retry error={error} refresh={() => { rules.refresh(); channels.refresh(); catalog.refresh() }} /> : !ready ? <Loading /> :
          <SettingsBand title={t('notificationAllRules')}>
            {entries.length ? <SettingsRows>
              {entries.map(rule => <SettingsRow key={rule.id} title={<Link href={subscriptionHref(rule.id)}>{rule.name}</Link>}
                description={label(rule.deviceId) + ' · ' + t(rule.enabled ? 'notificationEnabled' : 'notificationDisabled')}>
                <Link href={settingsHref('channels')}>{t('notificationChannels')}</Link>
              </SettingsRow>)}
            </SettingsRows> : <p>{t('notificationNoRules')}</p>}
            {!devices.length && <p>{t('waitingDevice')}</p>}
            {!channels.data?.length && <Link href={settingsHref('channels')}>{t('notificationAddChannel')}</Link>}
          </SettingsBand>}
      </SettingsPanel>}
  </SettingsFrame>
}
