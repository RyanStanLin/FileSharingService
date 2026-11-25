import {Stack} from '@primer/react'
import {samplingTopics, type Sampling, type SamplingTopic} from '../api/settings'
import {useLanguage, type Message} from '../i18n'
import {SettingsRows, SettingsSwitch, SettingsText} from './SettingsFields'
import styles from './settings.module.css'

const labels = {
  cpu: 'settingsCpu', memory: 'settingsMemory', disk: 'settingsDisk', battery: 'settingsBattery',
  displays: 'settingsDisplays', network: 'settingsNetwork', system: 'settingsSystem', agent: 'settingsAgent',
  power: 'settingsPower', storage: 'settingsStorage', appsRunning: 'settingsAppsRunning',
} satisfies Record<SamplingTopic, Message>

export interface SamplingDraft {
  intervals: Record<SamplingTopic, string>
  keepAwake: boolean
}

export function samplingDraft(settings: Sampling): SamplingDraft {
  return {
    intervals: Object.fromEntries(samplingTopics.map(topic => [topic, String(settings[topic])])) as SamplingDraft['intervals'],
    keepAwake: settings.keepAwake,
  }
}

function validInterval(value: string) {
  return /^\d+$/.test(value) && (Number(value) === 0 || (Number(value) >= 5 && Number(value) <= 3600))
}

export function samplingValues(draft: SamplingDraft): Sampling | undefined {
  if (!samplingTopics.every(topic => validInterval(draft.intervals[topic]))) return
  const intervals = Object.fromEntries(samplingTopics.map(topic => [topic, Number(draft.intervals[topic])]))
  return {...intervals, keepAwake: draft.keepAwake} as Sampling
}

export function SamplingFields({draft, change, disabled}: {
  draft: SamplingDraft; change: (draft: SamplingDraft) => void; disabled?: boolean
}) {
  const {t} = useLanguage()
  return <Stack gap="normal">
    <div className={styles.intervalGrid}>
      {samplingTopics.map(topic => <SettingsText key={topic} label={t(labels[topic])} inputMode="numeric"
        value={draft.intervals[topic]} maxLength={4} required disabled={disabled}
        error={validInterval(draft.intervals[topic]) ? undefined : t('settingsIntervalError')}
        onChange={event => change({...draft, intervals: {...draft.intervals, [topic]: event.target.value}})} />)}
    </div>
    <SettingsRows>
      <SettingsSwitch title={t('settingsKeepAwake')} description={t('settingsKeepAwakeHelp')} checked={draft.keepAwake}
        disabled={disabled} onChange={keepAwake => change({...draft, keepAwake})} />
    </SettingsRows>
  </Stack>
}
