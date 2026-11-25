import {Button} from '@primer/react'
import {setAccess} from '../api/devices'
import type {MaintenanceStatus} from '../api/maintenance'
import type {Device} from '../api/types'
import {useLanguage, type Message} from '../i18n'
import {MaintenanceCountdown} from '../maintenance/MaintenanceCountdown'
import type {MaintenanceControl} from '../maintenance/useMaintenance'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {Timestamp} from '../ui/Timestamp'
import {useTask} from '../ui/async'
import {SettingsRow, SettingsRows, SettingsSwitch} from './SettingsFields'
import {SettingsBand, SettingsPanel} from './SettingsPanel'

const stateMessages = {
  inactive: 'maintenanceInactive', preparing: 'maintenancePreparing', active: 'maintenanceActive',
  ended: 'maintenanceEnded', expired: 'maintenanceExpired',
} as const satisfies Record<MaintenanceStatus['state'], Message>

export function MaintenanceSettings({device, maintenance, refreshDevice}: {
  device: Device; maintenance: MaintenanceControl; refreshDevice: () => void
}) {
  const {t} = useLanguage()
  const authorization = useTask()
  const {status, countdown, open, canStart, canEnd, busy, actionError, readError, toggle, refresh} = maintenance
  const {online, connectionId, accessGranted} = device.connection
  const needsAccess = !open && online && !!connectionId && status?.supported && !accessGranted
  const unavailable = open ? !online && 'maintenanceActiveOffline'
    : !online ? 'maintenanceOffline' : status && !status.supported ? 'maintenanceUpgrade'
      : needsAccess && 'maintenanceAuthorize'
  const phase = busy ? open ? 'maintenanceEnding' : 'maintenancePreparing' : status && stateMessages[status.state]

  function authorize() {
    void authorization.run(async signal => {
      try { await setAccess(device, true, signal) } finally { refreshDevice() }
    })
  }

  return <SettingsPanel title={t('maintenanceTitle')}>
    {!status ? readError ? <Retry error={readError} refresh={refresh} /> : <Loading /> :
      <SettingsBand>
        <SettingsRows>
          <SettingsSwitch size="medium" title={t('maintenanceToggle')} description={t('maintenanceToggleHelp')}
            checked={open} disabled={open ? !canEnd : !canStart} loading={busy} onChange={toggle} />
          <SettingsRow title={t('maintenanceStatus')} description={unavailable ? t(unavailable) : undefined}>
            {phase && <span role="status">{t(phase)}</span>}
          </SettingsRow>
          {countdown && <>
            <SettingsRow title={t('maintenanceRemaining')}><MaintenanceCountdown value={countdown} /></SettingsRow>
            <SettingsRow title={t('maintenanceExpiresAt')}><Timestamp value={status.expiresAt} variant="exact" /></SettingsRow>
          </>}
          {needsAccess && <SettingsRow title={t('settingsRemoteAccess')}>
            <Button size="medium" loading={authorization.busy} onClick={authorize}>{t('allowConnection')}</Button>
          </SettingsRow>}
        </SettingsRows>
        <ErrorText error={actionError ?? readError ?? authorization.error} />
        {Boolean(readError) && <div><Button size="medium" disabled={busy} onClick={refresh}>{t('retry')}</Button></div>}
      </SettingsBand>}
  </SettingsPanel>
}
