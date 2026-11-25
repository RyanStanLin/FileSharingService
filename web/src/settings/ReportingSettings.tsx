import {useState} from 'react'
import {readPolicy, updatePolicy, type DevicePolicy} from '../api/settings'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {Loading, Retry} from '../ui/Feedback'
import {useResource, useTask} from '../ui/async'
import {SamplingFields, samplingDraft, samplingValues} from './SamplingFields'
import {SettingsRows, SettingsSwitch} from './SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'

export function ReportingSettings({device, refresh}: {device: Device; refresh: () => void}) {
  const {t} = useLanguage()
  const resource = useResource(device.id, signal => readPolicy(device.id, signal))
  if (!resource.data) return <SettingsPanel title={t('settingsReporting')} description={t('settingsReportingHelp')}>
    {resource.error ? <Retry error={resource.error} refresh={resource.refresh} /> : <Loading />}
  </SettingsPanel>
  return <PolicyEditor key={device.id} current={resource.data} refresh={refresh} />
}

function PolicyEditor({current, refresh}: {current: DevicePolicy; refresh: () => void}) {
  const {t} = useLanguage()
  const [inherited, setInherited] = useState(current.inherited)
  const [policy, setPolicy] = useState(current)
  const [draft, setDraft] = useState(() => samplingDraft(current.settings))
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const values = samplingValues(draft)
  const dirty = inherited !== policy.inherited || (!inherited &&
    JSON.stringify(draft) !== JSON.stringify(samplingDraft(policy.settings)))

  function show(updated: DevicePolicy) {
    setPolicy(updated)
    setInherited(updated.inherited)
    setDraft(samplingDraft(updated.settings))
  }

  return <SettingsPanel title={t('settingsReporting')} description={t('settingsReportingHelp')} busy={task.busy}
    disabled={!dirty || (!inherited && !values)} onApply={() => void task.run(async signal => {
      if (!inherited && !values) return
      show(await updatePolicy(policy, inherited ? null : values!, signal))
      setSaved(true)
      refresh()
    })}>
    <SettingsBand title={t('settingsProfile')}>
      <SettingsRows>
        <SettingsSwitch title={t('settingsInherit')} description={t('settingsInheritHelp')} checked={inherited}
          disabled={task.busy} onChange={setInherited} />
      </SettingsRows>
      <SettingsNotice saved={saved && !dirty} error={task.error} reload={() => void task.run(async signal => {
        show(await readPolicy(policy.deviceId, signal))
        setSaved(false)
      })} />
    </SettingsBand>
    <SettingsBand title={t('settingsIntervals')} description={t('settingsIntervalsHelp')}>
      <SamplingFields draft={draft} change={setDraft} disabled={inherited || task.busy} />
    </SettingsBand>
  </SettingsPanel>
}
