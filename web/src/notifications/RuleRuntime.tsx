import {Button, Link} from '@primer/react'
import {ApiError} from '../api/client'
import {setAccess} from '../api/devices'
import type {NotificationRule, NotificationWatch} from '../api/notificationTypes'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {SettingsRow, SettingsRows} from '../settings/SettingsFields'
import {SettingsBand} from '../settings/SettingsPanel'
import {ErrorText} from '../ui/Feedback'
import {TimestampDetails} from '../ui/TimestampDetails'
import {useTask} from '../ui/async'
import {deliveryUrl, watchLabel} from './notificationLabels'

export function RuleAuthorization({device, refresh}: {device?: Device; refresh: () => void}) {
  const {t} = useLanguage()
  const task = useTask()
  return <SettingsRow title={t('settingsRemoteAccess')} description={<>
    {t('notificationDeviceHelp')}
    <ErrorText error={task.error} />
  </>}>
    <Button size="medium" disabled={!device?.connection.online || !device.connection.connectionId || device.connection.accessGranted}
      loading={task.busy} onClick={() => {
        if (!device) return
        void task.run(async signal => { try { await setAccess(device, true, signal) } finally { refresh() } })
      }}>
      {t(device?.connection.accessGranted ? 'notificationEnabled' : 'allowConnection')}
    </Button>
  </SettingsRow>
}

export function RuleRuntime({rule, watches, watchError}: {
  rule: NotificationRule; watches?: NotificationWatch[]; watchError?: unknown
}) {
  const {t, locale, errorText} = useLanguage()
  const count = new Intl.NumberFormat(locale)
  const watch = watches?.find(item => item.ruleIds.includes(rule.id))
  return <SettingsBand title={t('notificationHistory')}>
    <SettingsRows>
      <SettingsRow title={t('notificationMatches')} description={<TimestampDetails label="notificationLastMatch" value={rule.lastMatchedAt} />}>
        {count.format(rule.matchedEvents)}
      </SettingsRow>
      <SettingsRow title={t('notificationEnqueued')}>{count.format(rule.enqueuedDeliveries)}</SettingsRow>
      <SettingsRow title={t('notificationSkipped')}>{count.format(rule.skippedDeliveries)}</SettingsRow>
      {rule.filter?.file && <SettingsRow title={t('notificationWatch')} description={
        watchError ? <ErrorText error={watchError} /> : watch ? <>
          {watch.path || '/'}
          {watch.error && <> · {errorText(new ApiError(0, watch.error))}</>}
          {watch.checkedAt && <> · <TimestampDetails label="notificationWatch" value={watch.checkedAt} /></>}
        </> : watches ? t('notificationWatchNone') : undefined
      }>
        {watch ? t(watchLabel[watch.state]) : !watches ? t('loading') : undefined}
      </SettingsRow>}
    </SettingsRows>
    <Link href={deliveryUrl({ruleId: rule.id})}>{t('notificationHistory')}</Link>
  </SettingsBand>
}
