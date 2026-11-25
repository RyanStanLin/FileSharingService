import {useState} from 'react'
import {Button, Link} from '@primer/react'
import {PlusIcon} from '@primer/octicons-react'
import {deleteProfile, readProfiles, saveProfile, type CollectionProfile} from '../api/settings'
import {useLanguage} from '../i18n'
import {Loading, Retry} from '../ui/Feedback'
import {useResource, useTask} from '../ui/async'
import {DeleteSetting} from './DeleteSetting'
import {SamplingFields, samplingDraft, samplingValues} from './SamplingFields'
import {SettingsRow, SettingsRows, SettingsText} from './SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'
import {NEW_ITEM, settingsHref} from './settingsLocation'

export function ProfileSettings({item, refresh}: {item?: string; refresh: () => void}) {
  const {t} = useLanguage()
  const profiles = useResource('profiles', readProfiles)
  function changed() {
    profiles.refresh()
    refresh()
  }
  const current = profiles.data?.find(profile => profile.id === item)
  const fallback = profiles.data?.find(profile => profile.id === 'default')
  if (fallback && (current || item === NEW_ITEM)) return <ProfileEditor key={item} current={current} fallback={fallback} refresh={changed} />

  return <SettingsPanel title={t('settingsProfiles')} description={t('settingsProfilesHelp')}
    actions={<Button size="medium" leadingVisual={PlusIcon} disabled={!fallback}
      onClick={() => { window.location.hash = settingsHref('profiles', NEW_ITEM) }}>{t('settingsNewProfile')}</Button>}>
    {profiles.error ? <Retry error={profiles.error} refresh={profiles.refresh} /> : !profiles.data ? <Loading /> :
      <SettingsBand>
        {profiles.data.length > 0 ? <SettingsRows>
          {profiles.data.map(profile => <SettingsRow key={profile.id} title={<Link href={settingsHref('profiles', profile.id)}>{profile.name}</Link>}>
            {null}
          </SettingsRow>)}
        </SettingsRows> : <p>{t('settingsNoProfiles')}</p>}
      </SettingsBand>}
  </SettingsPanel>
}

function ProfileEditor({current, fallback, refresh}: {current?: CollectionProfile; fallback: CollectionProfile; refresh: () => void}) {
  const {t} = useLanguage()
  const [base, setBase] = useState(current)
  const [name, setName] = useState(current?.name ?? '')
  const [draft, setDraft] = useState(() => samplingDraft((current ?? fallback).settings))
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const values = samplingValues(draft)
  const dirty = !base || name.trim() !== base.name || JSON.stringify(draft) !== JSON.stringify(samplingDraft(base.settings))

  function show(profile: CollectionProfile) {
    setBase(profile)
    setName(profile.name)
    setDraft(samplingDraft(profile.settings))
  }

  return <SettingsPanel title={base?.name ?? t('settingsNewProfile')} description={t('settingsProfilesHelp')} busy={task.busy}
    actions={<Link href={settingsHref('profiles')}>{t('settingsProfiles')}</Link>}
    disabled={!dirty || !values || !name.trim()} onApply={() => void task.run(async signal => {
      if (!values) return
      show(await saveProfile(base, name.trim(), values, signal))
      setSaved(true)
      refresh()
    })}>
    <SettingsBand>
      <SettingsText label={t('settingsProfileName')} required maxLength={120} value={name} disabled={task.busy}
        onChange={event => setName(event.target.value)} />
      <SettingsNotice error={task.error} saved={saved && !dirty} reload={base && (() => void task.run(async signal => {
        const latest = (await readProfiles(signal)).find(profile => profile.id === base.id)
        if (latest) show(latest)
        else window.location.hash = settingsHref('profiles')
        setSaved(false)
      }))} />
    </SettingsBand>
    <SettingsBand title={t('settingsIntervals')} description={t('settingsIntervalsHelp')}>
      <SamplingFields draft={draft} change={setDraft} disabled={task.busy} />
    </SettingsBand>
    {base && base.id !== 'default' && <SettingsBand title={t('settingsManagement')}>
      <SettingsRows>
        <SettingsRow title={t('settingsProfileDelete')}>
          <DeleteSetting title={t('settingsProfileDelete')} description={t('settingsProfileDeleteHelp', {name: base.name})}
            disabled={task.busy} remove={async signal => {
              await deleteProfile(base.id, signal)
              refresh()
              window.location.hash = settingsHref('profiles')
            }} />
        </SettingsRow>
      </SettingsRows>
    </SettingsBand>}
  </SettingsPanel>
}
