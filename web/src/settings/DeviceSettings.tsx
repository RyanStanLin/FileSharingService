import {useState} from 'react'
import {setAccess} from '../api/devices'
import {readDevice, readProfiles, updateDevice, type CollectionProfile} from '../api/settings'
import {ApiError} from '../api/client'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {Loading, Retry} from '../ui/Feedback'
import {useResource, useTask} from '../ui/async'
import {SettingsRow, SettingsRows, SettingsSwitch, SettingsText} from './SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'

export function DeviceSettings({device, refresh}: {device: Device; refresh: () => void}) {
  const {t} = useLanguage()
  const profiles = useResource('device-profiles', readProfiles)
  if (!profiles.data) return <SettingsPanel title={t('settingsGeneral')} description={t('settingsGeneralHelp')}>
    {profiles.error ? <Retry error={profiles.error} refresh={profiles.refresh} /> : <Loading />}
  </SettingsPanel>
  return <DeviceEditor key={device.id} device={device} profiles={profiles.data} refresh={refresh} />
}

function DeviceEditor({device, profiles, refresh}: {device: Device; profiles: CollectionProfile[]; refresh: () => void}) {
  const {t} = useLanguage()
  const [base, setBase] = useState(device)
  const [name, setName] = useState(device.name)
  const [profileId, setProfileId] = useState(device.profileId ?? 'default')
  const [access, setAccessDraft] = useState<{id: string; enabled: boolean}>()
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const connection = device.connection
  const dirty = name.trim() !== base.name || profileId !== (base.profileId ?? 'default') || access !== undefined
  const available = connection.online && !!connection.connectionId

  function reset(current: Device) {
    setBase(current)
    setName(current.name)
    setProfileId(current.profileId ?? 'default')
    setAccessDraft(undefined)
    setSaved(false)
  }

  function apply() {
    void task.run(async signal => {
      setSaved(false)
      try {
        if (name.trim() !== base.name || profileId !== (base.profileId ?? 'default')) {
          const updated = await updateDevice(base, name.trim(), profileId, signal)
          setBase(updated)
          setName(updated.name)
        }
        if (access) {
          if (access.id !== connection.connectionId || !available) throw new ApiError(409, 'agent_connection_changed')
          if (access.enabled !== connection.accessGranted) await setAccess(device, access.enabled, signal)
          setAccessDraft(undefined)
        }
        setSaved(true)
      } finally {
        refresh()
      }
    })
  }

  return <SettingsPanel title={t('settingsGeneral')} description={t('settingsGeneralHelp')} onApply={apply}
    busy={task.busy} disabled={!dirty || !name.trim()}>
    <SettingsBand title={t('settingsDevice')}>
      <SettingsText label={t('settingsDeviceName')} value={name} onChange={event => setName(event.target.value)}
        aria-required="true" maxLength={120} disabled={task.busy} />
      <SettingsText label={t('settingsDeviceId')} value={device.id} readOnly />
      <SettingsRows>
        <SettingsSwitch title={t('settingsRemoteAccess')} description={t(available ? 'settingsRemoteAccessHelp' : 'settingsRemoteAccessOffline')}
          checked={access?.enabled ?? connection.accessGranted} disabled={!available || task.busy}
          onChange={enabled => setAccessDraft(enabled === connection.accessGranted || !connection.connectionId
            ? undefined : {enabled, id: connection.connectionId})} />
        <SettingsRow title={t('settingsProfile')} description={t('settingsDeviceProfileHelp')}>
          <ChoiceMenu label={t('settingsProfile')} value={profileId} options={profiles.map(profile => ({value: profile.id, label: profile.name}))}
            disabled={task.busy} prefix={t('settingsProfilePrefix')} onChange={setProfileId} />
        </SettingsRow>
      </SettingsRows>
      <SettingsNotice saved={saved && !dirty} error={task.error} reload={() => void task.run(async signal => {
        reset(await readDevice(device.id, signal))
        refresh()
      })} />
    </SettingsBand>
  </SettingsPanel>
}
