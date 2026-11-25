import {useState} from 'react'
import {Link} from '@primer/react'
import {readShares} from '../api/devices'
import {deleteRoot, revokeDevice, writeRoot} from '../api/settings'
import type {Device, LocalRoot, Root} from '../api/types'
import {useLanguage} from '../i18n'
import {BackButton} from '../ui/BackButton'
import {Loading, Retry} from '../ui/Feedback'
import {useResource, useTask} from '../ui/async'
import {DeleteSetting} from './DeleteSetting'
import {PermissionSettings} from './PermissionSettings'
import {SettingsRow, SettingsRows, SettingsSwitch, SettingsText} from './SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'
import {settingsHref} from './settingsLocation'

export function FileAccessSettings({device, item, refreshDevice}: {device: Device; item?: string; refreshDevice: () => void}) {
  const {t} = useLanguage()
  const shares = useResource(device.id, signal => readShares(device.id, signal))
  const {local = [], roots = []} = shares.data ?? {}
  const scope = local.find(root => root.rootKey === item)
  const grant = roots.find(root => root.rootKey === item)
  if (scope || grant) return <GrantEditor key={item} device={device} scope={scope} grant={grant} refresh={shares.refresh} />

  return <SettingsPanel title={t('settingsFileAccess')} description={t('settingsFileAccessHelp')}>
    {!shares.data ? shares.error ? <Retry error={shares.error} refresh={shares.refresh} /> : <Loading /> :
      <SettingsBand title={t('sharedFolders')}>
        {local.length || roots.length ? <SettingsRows>
          {local.map(folder => {
            const record = roots.find(root => root.rootKey === folder.rootKey)
            return <SettingsRow key={folder.rootKey} title={<Link href={settingsHref('fileAccess', folder.rootKey)}>{folder.label}</Link>}
              description={t(record?.enabled ? record.writable && folder.writable ? 'shareWritable' : 'shareReadOnly' : 'shareDisabled')}>
              {null}
            </SettingsRow>
          })}
          {roots.filter(root => !local.some(folder => folder.rootKey === root.rootKey)).map(root =>
            <SettingsRow key={root.id} title={<Link href={settingsHref('fileAccess', root.rootKey)}>{root.label}</Link>}
              description={t('settingsLocalFolderUnavailable')}>{null}</SettingsRow>)}
        </SettingsRows> : <p>{t('emptySharesHelp')}</p>}
      </SettingsBand>}
    <PermissionSettings device={device} />
    <SettingsBand title={t('settingsManagement')}>
      <SettingsRows>
        <SettingsRow title={t('settingsRevokeDevice')}>
          <DeleteSetting title={t('settingsRevokeDevice')} description={t('settingsRevokeDeviceHelp', {name: device.name})}
            remove={async signal => { await revokeDevice(device.id, signal); refreshDevice() }} />
        </SettingsRow>
      </SettingsRows>
    </SettingsBand>
  </SettingsPanel>
}

function GrantEditor({device, scope, grant, refresh}: {
  device: Device; scope?: LocalRoot; grant?: Root; refresh: () => void
}) {
  const {t} = useLanguage()
  const [base, setBase] = useState(grant)
  const [label, setLabel] = useState(grant?.label ?? scope?.label ?? '')
  const [writable, setWritable] = useState(grant?.writable ?? false)
  const [enabled, setEnabled] = useState(grant?.enabled ?? true)
  const [saved, setSaved] = useState(false)
  const task = useTask()
  const dirty = !base || label.trim() !== base.label || writable !== base.writable || enabled !== base.enabled

  function show(record: Root) {
    setBase(record)
    setLabel(record.label)
    setWritable(record.writable)
    setEnabled(record.enabled)
  }

  return <SettingsPanel title={base?.label ?? scope?.label ?? t('sharedFolders')} description={t('settingsFileAccessHelp')}
    actions={<BackButton to={settingsHref('fileAccess')} destination={t('sharedFolders')} />}
    busy={task.busy} disabled={!scope || !label.trim() || !dirty} onApply={scope && (() => void task.run(async signal => {
      show(await writeRoot(device.id, base, scope, {label: label.trim(), enabled, writable}, signal))
      setSaved(true)
      refresh()
    }))}>
    <SettingsBand>
      {scope ? <>
        <SettingsText label={t('settingsGrantLabel')} value={label} onChange={event => setLabel(event.target.value)}
          required maxLength={120} disabled={task.busy} />
        <SettingsRows>
          <SettingsSwitch title={t('settingsShareEnabled')} checked={enabled} onChange={setEnabled} disabled={task.busy} />
          <SettingsSwitch title={t('settingsWriteAccess')} description={t('settingsWriteAccessHelp')} checked={writable}
            onChange={setWritable} disabled={(!scope.writable && !writable) || task.busy} />
        </SettingsRows>
      </> : <p>{t('settingsLocalFolderUnavailable')}</p>}
      <SettingsNotice error={task.error} saved={saved && !dirty} reload={() => void task.run(async signal => {
        const latest = (await readShares(device.id, signal)).roots.find(root => root.rootKey === scope?.rootKey)
        if (latest) show(latest)
        else window.location.hash = settingsHref('fileAccess')
        setSaved(false)
      })} />
    </SettingsBand>
    {base && <SettingsBand title={t('settingsManagement')}>
      <SettingsRows>
        <SettingsRow title={t('settingsRemoveGrant')}>
          <DeleteSetting title={t('settingsRemoveGrant')} description={t('settingsRemoveGrantHelp', {name: base.label})}
            disabled={task.busy} remove={async signal => {
              await deleteRoot(device.id, base.id, signal)
              refresh()
              window.location.hash = settingsHref('fileAccess')
            }} />
        </SettingsRow>
      </SettingsRows>
    </SettingsBand>}
  </SettingsPanel>
}
