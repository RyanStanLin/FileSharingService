import {Label} from '@primer/react'
import {useLanguage} from '../i18n'
import {Timestamp} from '../ui/Timestamp'
import styles from './maintenance.module.css'

export function MaintenanceCountdown({value, showContext}: {value: string; showContext?: boolean}) {
  const {t} = useLanguage()
  return <Label variant="attention" size="large" role="timer" aria-label={t('maintenanceRemaining')} className={styles.countdown}>
    {showContext && <span aria-hidden="true">{t('maintenanceShort')}</span>}
    <Timestamp value={value} variant="countdown" />
  </Label>
}
