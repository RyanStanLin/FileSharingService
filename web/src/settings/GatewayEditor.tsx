import {useState} from 'react'
import {ApiError} from '../api/client'
import {
  createGatewayAccount, gatewayMode, readGatewayAccount, removeGatewayAccount, updateGatewayAccount, validGatewayPassword,
  type GatewayAccount, type GatewayEndpoint, type GatewayScope,
} from '../api/gateway'
import {readRoots} from '../api/settings'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {BackButton} from '../ui/BackButton'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource, useTask} from '../ui/async'
import {DeleteSetting} from './DeleteSetting'
import {GatewayPassword, IssuedPassword} from './GatewayPassword'
import {GatewayConnections} from './GatewayStatus'
import {SettingsRow, SettingsRows, SettingsSwitch, SettingsText} from './SettingsFields'
import {SettingsMultiChoice} from './SettingsMultiChoice'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'
import {settingsHref} from './settingsLocation'

function accountDraft(account: GatewayAccount | undefined, endpoints: GatewayEndpoint[]) {
  return {
    name: account?.name ?? '',
    mode: account?.mode ?? (endpoints[0] ? gatewayMode(endpoints[0].mode) : 'sftp'),
    disabled: account?.disabled ?? false,
    scope: account?.scope ?? 'activeHomes' as GatewayScope,
    rootIds: account?.rootIds ?? [],
    password: '',
  }
}

export function GatewayEditor({current, endpoints, devices, refresh}: {
  current?: GatewayAccount; endpoints: GatewayEndpoint[]; devices: Device[]; refresh: () => void
}) {
  const {t, errorText} = useLanguage()
  const [base, setBase] = useState(current)
  const [draft, setDraft] = useState(() => accountDraft(current, endpoints))
  const [issued, setIssued] = useState<string>()
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const modes = Array.from(new Set([...endpoints.map(endpoint => gatewayMode(endpoint.mode)), ...(base ? [base.mode] : [])]))
  const nameValid = /^[A-Za-z0-9_.-]{1,64}$/.test(draft.name.trim())
  const passwordValid = validGatewayPassword(draft.password)
  const dirty = !base || JSON.stringify(draft) !== JSON.stringify(accountDraft(base, endpoints))

  function show(updated: GatewayAccount) {
    setBase(updated)
    setDraft(accountDraft(updated, endpoints))
    setSaved(true)
    refresh()
  }

  return <SettingsPanel title={base?.name ?? t('settingsGatewayNew')} description={t('settingsGatewayHelp')}
    actions={<BackButton to={settingsHref('gateway')} destination={t('settingsGateway')} />} busy={task.busy}
    disabled={!dirty || !nameValid || !passwordValid || (draft.scope === 'grants' && draft.rootIds.length === 0) || !modes.length}
    onApply={() => void task.run(async signal => {
      const input = {...draft, name: draft.name.trim(), rootIds: draft.scope === 'grants' ? draft.rootIds : [], password: draft.password || undefined}
      if (base) show(await updateGatewayAccount(base, input, signal))
      else {
        const created = await createGatewayAccount(input, signal)
        show(created.account)
        setIssued(created.password)
      }
    })}>
    <SettingsBand>
      <SettingsText label={t('settingsGatewayAccount')} value={draft.name} disabled={task.busy} required maxLength={64}
        error={draft.name && !nameValid ? errorText(new ApiError(400, 'invalid_account_name')) : undefined}
        onChange={event => setDraft({...draft, name: event.target.value})} />
      {!base && <SettingsText label={t('settingsGatewayPassword')} caption={t('settingsGatewayPasswordHelp')} type="password"
        value={draft.password} autoComplete="new-password" maxLength={128} disabled={task.busy}
        error={!passwordValid ? errorText(new ApiError(400, 'invalid_ftp_password')) : undefined}
        onChange={event => setDraft({...draft, password: event.target.value})} />}
      <SettingsRows>
        <SettingsRow title={t('settingsGatewayMode')}>
          <ChoiceMenu label={t('settingsGatewayMode')} value={draft.mode} disabled={task.busy || !!base}
            options={modes.map(value => ({value, label: value.toUpperCase()}))} onChange={mode => setDraft({...draft, mode})} />
        </SettingsRow>
        <SettingsRow title={t('settingsGatewayScope')}>
          <ChoiceMenu<GatewayScope> label={t('settingsGatewayScope')} value={draft.scope} disabled={task.busy}
            options={[{value: 'activeHomes', label: t('settingsGatewayActiveHomes')}, {value: 'grants', label: t('settingsGatewayGrants')}]}
            onChange={scope => setDraft({...draft, scope})} />
        </SettingsRow>
        {draft.scope === 'grants' && <GatewayRoots devices={devices} value={draft.rootIds} disabled={task.busy}
          change={rootIds => setDraft({...draft, rootIds})} />}
        {base && <SettingsSwitch title={t('settingsGatewayEnabled')} checked={!draft.disabled} disabled={task.busy}
          onChange={enabled => setDraft({...draft, disabled: !enabled})} />}
      </SettingsRows>
      <SettingsNotice saved={saved && !dirty} error={task.error} reload={base && (() => void task.run(async signal => {
        show(await readGatewayAccount(base.id, signal))
        setSaved(false)
      }))} />
    </SettingsBand>
    {base && <>
      <GatewayPassword account={base} disabled={task.busy || dirty} rotate={show} />
      <GatewayConnections accounts={[base]} accountId={base.id} />
      <SettingsBand title={t('settingsManagement')}>
        <SettingsRows><SettingsRow title={t('settingsGatewayDelete')}>
          <DeleteSetting title={t('settingsGatewayDelete')} description={t('settingsGatewayDeleteHelp', {name: base.name})}
            disabled={task.busy} remove={async signal => {
              await removeGatewayAccount(base.id, signal)
              refresh()
              window.location.hash = settingsHref('gateway')
            }} />
        </SettingsRow></SettingsRows>
      </SettingsBand>
    </>}
    {issued && <Modal title={t('settingsGatewayPassword')} onClose={() => setIssued(undefined)}
      footerButtons={[{content: t('close'), size: 'medium', onClick: () => setIssued(undefined)}]}>
      <IssuedPassword password={issued} />
    </Modal>}
  </SettingsPanel>
}

function GatewayRoots({devices, value, change, disabled}: {
  devices: Device[]; value: string[]; change: (value: string[]) => void; disabled: boolean
}) {
  const {t} = useLanguage()
  const roots = useResource(devices.map(device => device.id).join(','), async signal =>
    (await Promise.all(devices.map(async device => (await readRoots(device.id, signal)).filter(root => root.enabled)
      .map(root => ({id: root.id, text: device.name + ' / ' + root.label}))))).flat())
  const items = [...roots.data ?? []]
  for (const id of value) if (!items.some(item => item.id === id)) items.push({id, text: t('notificationUnavailableRoot', {id})})
  return <SettingsRow title={t('sharedFolders')}
    description={roots.error ? <ErrorText error={roots.error} /> : roots.pending && !roots.data ? <Loading /> : undefined}>
    <SettingsMultiChoice label={t('settingsGatewayGrants')} value={value} items={items} disabled={disabled || !roots.data} change={change} max={64} />
  </SettingsRow>
}
