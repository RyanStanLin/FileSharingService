import type {GatewayAccount, GatewayEndpoint} from '../api/gateway'
import {gatewayMode, readGatewayConnections} from '../api/gateway'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {TimestampDetails} from '../ui/TimestampDetails'
import {useRefresh, useResource} from '../ui/async'
import {SettingsRow, SettingsRows} from './SettingsFields'
import {SettingsBand} from './SettingsPanel'

export function GatewayEndpoints({endpoints}: {endpoints: GatewayEndpoint[]}) {
  const {t} = useLanguage()
  return <SettingsBand title={t('settingsGatewayEndpoints')}>
    {endpoints.length > 0 ? <SettingsRows>{endpoints.map(endpoint => <SettingsRow key={endpoint.mode + endpoint.address}
      title={<code>{endpoint.address}</code>} description={endpoint.hostKeyFingerprint}>
      {gatewayMode(endpoint.mode).toUpperCase()} · {t(endpoint.available === false ? 'settingsGatewayUnavailable' : 'settingsGatewayAvailable')}
    </SettingsRow>)}</SettingsRows> : <p>{t('settingsGatewayNoEndpoints')}</p>}
  </SettingsBand>
}

export function GatewayConnections({accounts, accountId}: {accounts: GatewayAccount[]; accountId?: string}) {
  const {t} = useLanguage()
  const clients = useResource(accountId ?? 'gateway-client-list', signal => readGatewayConnections(accountId, signal))
  useRefresh(true, clients.refresh, 5000)
  return <SettingsBand title={t('settingsGatewayConnections')}>
    {clients.pending && !clients.data ? <Loading /> : null}
    {clients.data && (clients.data.length ? <SettingsRows>
      {clients.data.map(item => <SettingsRow key={item.id} title={accounts.find(account => account.id === item.accountId)?.name ?? item.accountId}
        description={item.protocol.toUpperCase() + ' · ' + item.peerAddress}>
        <TimestampDetails label="settingsGatewayConnections" value={item.lastActivityAt} />
      </SettingsRow>)}
    </SettingsRows> : <p>{t('settingsGatewayNoConnections')}</p>)}
    <ErrorText error={clients.error} />
  </SettingsBand>
}
