import {Banner} from '@primer/react'
import {setUpNotificationEncryption} from '../api/notifications'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {useTask} from '../ui/async'

export function NotificationEncryptionSetup({onConfigured}: {onConfigured: () => void}) {
  const {t} = useLanguage()
  const task = useTask()
  return <>
    <Banner variant="warning" title={t('notificationVaultUnavailable')} description={t('notificationEncryptionSetupHelp')}
      primaryAction={<Banner.PrimaryAction type="button" size="medium" loading={task.busy}
        onClick={() => void task.run(async signal => {
          await setUpNotificationEncryption(signal)
          onConfigured()
        })}>{t('notificationEncryptionSetup')}</Banner.PrimaryAction>} />
    <ErrorText error={task.error} />
  </>
}
