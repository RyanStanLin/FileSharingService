import type {NotificationEventType} from '../api/notificationTypes'
import {readRoots} from '../api/settings'
import {useLanguage, type Message} from '../i18n'
import {SettingsRow, SettingsRows, SettingsText} from '../settings/SettingsFields'
import {SettingsBand} from '../settings/SettingsPanel'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ErrorText, Loading} from '../ui/Feedback'
import {useResource} from '../ui/async'
import {hasFileDetails, wholeNumber, type RuleDraft} from './ruleDraft'

const optionalFields = [
  ['bundleId', 'notificationBundleId', 255], ['applicationId', 'notificationApplicationId', 256], ['storageId', 'notificationStorageId', 120],
] as const satisfies readonly (readonly [keyof RuleDraft, Message, number])[]

const entryKinds = [
  ['', 'notificationAnyEntry'], ['file', 'notificationFile'], ['directory', 'notificationDirectoryKind'],
  ['symlink', 'notificationSymlink'], ['other', 'notificationOther'],
] as const satisfies readonly (readonly [string, Message])[]

interface Props {
  draft: RuleDraft
  types: NotificationEventType[]
  change: (patch: Partial<RuleDraft>) => void
  disabled: boolean
  attempted: boolean
}

export function RuleFilters({draft, types, change, disabled, attempted}: Props) {
  const {t} = useLanguage()
  const fields = new Set(types.flatMap(type => type.filters))
  return <SettingsBand title={t('notificationFilters')}>
    <SettingsText label={t('notificationCooldown')} caption={t('notificationCooldownHelp')} value={draft.cooldown}
      disabled={disabled} required inputMode="numeric" maxLength={5}
      error={attempted && !wholeNumber(draft.cooldown, 0, 86400) ? t('settingsWholeNumber', {min: 0, max: 86400}) : undefined}
      onChange={event => change({cooldown: event.target.value})} />
    {optionalFields.filter(([field]) => fields.has(field)).map(([field, key, maxLength]) =>
      <SettingsText key={field} label={t(key)} value={draft[field]} maxLength={maxLength} disabled={disabled}
        onChange={event => change({[field]: event.target.value})} />)}
    {fields.has('thresholdPercent') && <SettingsText label={t('notificationThreshold')} value={draft.threshold}
      disabled={disabled} required inputMode="numeric" maxLength={3}
      error={attempted && !wholeNumber(draft.threshold, 1, 100) ? t('settingsWholeNumber', {min: 1, max: 100}) : undefined}
      onChange={event => change({threshold: event.target.value})} />}
    {fields.has('file') && <DirectoryFilter draft={draft} types={types} disabled={disabled} change={change} attempted={attempted} />}
  </SettingsBand>
}

function DirectoryFilter({draft, types, change, disabled, attempted}: Props) {
  const {t} = useLanguage()
  const roots = useResource(draft.deviceId || null, signal => readRoots(draft.deviceId, signal))
  const options = (roots.data ?? []).filter(root => root.enabled).map(root => ({value: root.id, label: root.label}))
  if (draft.rootId && !options.some(option => option.value === draft.rootId)) {
    options.unshift({value: draft.rootId, label: t('notificationUnavailableRoot', {id: draft.rootId})})
  }
  const details = hasFileDetails(types)
  return <>
    <SettingsRows>
      <SettingsRow title={t('notificationSharedRoot')} description={
        roots.pending && !roots.data ? <Loading /> : roots.error ? <ErrorText error={roots.error} /> :
          attempted && !draft.rootId ? <span role="alert">{t('settingsRequired')}</span> :
            options.length === 0 ? t('notificationNoRoots') : undefined
      }>
        <ChoiceMenu label={t('notificationSharedRoot')} value={draft.rootId} options={options}
          disabled={disabled || options.length === 0} onChange={rootId => change({rootId})} />
      </SettingsRow>
    </SettingsRows>
    <SettingsText label={t('notificationDirectory')} caption={t('notificationDirectoryHelp')} value={draft.path}
      maxLength={3000} disabled={disabled} placeholder="Documents/Reports" onChange={event => change({path: event.target.value})} />
    {details && <>
      <SettingsText label={t('notificationNameGlob')} caption={t('notificationNameGlobHelp')} value={draft.nameGlob}
        maxLength={255} disabled={disabled} onChange={event => change({nameGlob: event.target.value})} />
      <SettingsRows>
        <SettingsRow title={t('notificationEntryKind')}>
          <ChoiceMenu label={t('notificationEntryKind')} value={draft.entryKind} disabled={disabled}
            options={entryKinds.map(([value, label]) => ({value, label: t(label)}))} onChange={entryKind => change({entryKind})} />
        </SettingsRow>
      </SettingsRows>
    </>}
  </>
}
