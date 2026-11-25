import {ApiError} from '../api/client'
import type {NotificationChannel} from '../api/notificationTypes'
import {useLanguage, type Message} from '../i18n'
import {SettingsRow, SettingsRows, SettingsSwitch, SettingsText} from '../settings/SettingsFields'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import type {ChannelDraft} from './channelDraft'

const barkLevels = [
  ['', 'notificationLevelDefault'], ['active', 'notificationLevelActive'], ['timeSensitive', 'notificationLevelTimeSensitive'],
  ['passive', 'notificationLevelPassive'], ['critical', 'notificationLevelCritical'],
] as const satisfies readonly (readonly [string, Message])[]

export const providers = [{value: 'bark', label: 'Bark'}, {value: 'telegram', label: 'Telegram'}] as const
export const providerName = (kind: NotificationChannel['kind']) => providers.find(provider => provider.value === kind)!.label

export function ChannelFields({draft, change, base, disabled, errors}: {
  draft: ChannelDraft; change: (draft: ChannelDraft) => void; base?: NotificationChannel; disabled: boolean; errors: Record<string, string>
}) {
  const {t, errorText} = useLanguage()
  const bark = draft.kind === 'bark'
  const changeField = (field: keyof ChannelDraft, value: string | boolean) => change({...draft, [field]: value})
  const invalid = (field: string) => errors[field] ? errorText(new ApiError(400, errors[field])) : undefined

  return <>
    <SettingsText label={t('notificationChannelName')} value={draft.name} onChange={event => changeField('name', event.target.value)}
      maxLength={120} required disabled={disabled} />
    <SettingsRows>
      <SettingsRow title={t('notificationChannelKind')}>
        <ChoiceMenu label={t('notificationChannelKind')} value={draft.kind} options={providers} disabled={disabled || !!base}
          onChange={value => changeField('kind', value)} />
      </SettingsRow>
      <SettingsSwitch title={t('notificationChannelEnabled')} checked={draft.enabled} disabled={disabled}
        onChange={value => changeField('enabled', value)} />
    </SettingsRows>
    {bark && <SettingsText label={t('notificationBarkServer')} value={draft.server} disabled={disabled} spellCheck={false}
      onChange={event => changeField('server', event.target.value)} error={invalid('server')} />}
    <SettingsText label={t(bark ? 'notificationBarkKey' : 'notificationTelegramToken')} type="password" autoComplete="new-password"
      maxLength={bark ? 128 : 149} disabled={disabled} value={draft.credential} error={invalid('credential')}
      caption={base?.credentialConfigured ? t('notificationCredentialSaved') : undefined}
      onChange={event => changeField('credential', event.target.value)} />
    {bark ? <>
      <SettingsText label={t('notificationBarkGroup')} value={draft.group} maxLength={80}
        disabled={disabled} onChange={event => changeField('group', event.target.value)} />
      <SettingsText label={t('notificationBarkSound')} value={draft.sound} maxLength={40}
        disabled={disabled} onChange={event => changeField('sound', event.target.value)} />
      <SettingsRows>
        <SettingsRow title={t('notificationBarkLevel')}>
          <ChoiceMenu label={t('notificationBarkLevel')} value={draft.level} disabled={disabled}
            options={barkLevels.map(([value, label]) => ({value, label: t(label)}))} onChange={value => changeField('level', value)} />
        </SettingsRow>
      </SettingsRows>
    </> : <>
      <SettingsText label={t('notificationTelegramChat')} value={draft.chatId} required disabled={disabled}
        maxLength={65} error={invalid('chatId')} onChange={event => changeField('chatId', event.target.value)} />
      <SettingsText label={t('notificationTelegramThread')} value={draft.thread} disabled={disabled} inputMode="numeric"
        maxLength={10} error={invalid('thread')} onChange={event => changeField('thread', event.target.value)} />
      <SettingsRows>
        <SettingsSwitch title={t('notificationTelegramSilent')} checked={draft.silent} disabled={disabled}
          onChange={value => changeField('silent', value)} />
      </SettingsRows>
    </>}
  </>
}
