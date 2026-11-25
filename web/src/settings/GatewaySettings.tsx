import {Button, Link} from '@primer/react'
import {PlusIcon} from '@primer/octicons-react'
import {readGatewayAccounts, readGatewayEndpoints} from '../api/gateway'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {Loading, Retry} from '../ui/Feedback'
import {useResource} from '../ui/async'
import {GatewayEditor} from './GatewayEditor'
import {GatewayConnections, GatewayEndpoints} from './GatewayStatus'
import {SettingsRow, SettingsRows} from './SettingsFields'
import {SettingsBand, SettingsPanel} from './SettingsPanel'
import {NEW_ITEM, settingsHref} from './settingsLocation'

export function GatewaySettings({item, devices}: {item?: string; devices: Device[]}) {
  const {t} = useLanguage()
  const accounts = useResource('gateway-accounts', readGatewayAccounts)
  const endpoints = useResource('gateway-endpoints', readGatewayEndpoints)
  const current = accounts.data?.find(account => account.id === item)
  if (accounts.data && endpoints.data && (current || item === NEW_ITEM)) {
    return <GatewayEditor key={item} current={current} endpoints={endpoints.data} devices={devices} refresh={accounts.refresh} />
  }

  const error = accounts.error ?? endpoints.error
  return <SettingsPanel title={t('settingsGateway')} description={t('settingsGatewayHelp')}
    actions={<Button size="medium" leadingVisual={PlusIcon} disabled={!endpoints.data?.length || !accounts.data}
      onClick={() => { window.location.hash = settingsHref('gateway', NEW_ITEM) }}>{t('settingsGatewayNew')}</Button>}>
    {error ? <Retry error={error} refresh={() => { accounts.refresh(); endpoints.refresh() }} /> : !accounts.data || !endpoints.data ? <Loading /> : <>
      <GatewayEndpoints endpoints={endpoints.data} />
      <SettingsBand title={t('settingsGateway')}>
        {accounts.data.length ? <SettingsRows>
          {accounts.data.map(account => <SettingsRow key={account.id} title={<Link href={settingsHref('gateway', account.id)}>{account.name}</Link>}
            description={account.mode.toUpperCase() + ' · ' + t(account.disabled ? 'notificationDisabled' : 'notificationEnabled')}>{null}</SettingsRow>)}
        </SettingsRows> : <p>{t('settingsGatewayNoAccounts')}</p>}
      </SettingsBand>
      <GatewayConnections accounts={accounts.data} />
    </>}
  </SettingsPanel>
}
