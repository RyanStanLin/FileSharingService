import {Button} from '@primer/react'
import {ApiError, request} from '../api/client'
import {deviceRoute, requestPermission} from '../api/devices'
import type {Device, Permission} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {useRefresh, useResource, useTask} from '../ui/async'
import {SettingsRow, SettingsRows} from './SettingsFields'
import {SettingsBand} from './SettingsPanel'

const permissions = {
  downloads: 'settingsDownloads', documents: 'settingsDocuments', desktop: 'settingsDesktop',
  inputMonitoring: 'settingsInputMonitoring', pasteboard: 'settingsPasteboard',
} as const

type Kind = keyof typeof permissions
const kinds = Object.keys(permissions) as Kind[]
type Snapshot = Partial<Record<Kind, Permission>>

export function PermissionSettings({device}: {device: Device}) {
  const {t} = useLanguage()
  const resource = useResource(device.id, async signal => {
    try {
      return (await request<{value: Snapshot}>(deviceRoute(device.id) + '/permissions', {signal})).value
    } catch (error) {
      if (error instanceof ApiError && error.code === 'snapshot_unavailable') return {}
      throw error
    }
  })
  useRefresh(device.connection.online, resource.refresh, 10_000, false)
  return <SettingsBand title={t('settingsPermissions')}>
    {resource.pending && !resource.data ? <Loading /> : <SettingsRows>
      {kinds.map(kind => <PermissionRow key={kind} kind={kind} device={device}
        permission={resource.data?.[kind]} refresh={resource.refresh} />)}
    </SettingsRows>}
    <ErrorText error={resource.error} />
  </SettingsBand>
}

function PermissionRow({kind, device, permission, refresh}: {
  kind: Kind; device: Device; permission?: Permission; refresh: () => void
}) {
  const {t} = useLanguage()
  const task = useTask()
  const available = device.connection.online && device.connection.accessGranted
  const pending = task.busy || permission?.phase === 'requesting'
  return <SettingsRow title={t(permissions[kind])} description={<>
    {t(pending ? 'requesting' : permission?.state ?? 'unknown')}
    {pending && <> · {t('permissionPrompt', {device: device.name})}</>}
    <ErrorText error={task.error} />
  </>}>
    <Button size="medium" disabled={!available || pending} onClick={() => void task.run(async signal => {
      try { await requestPermission(device.id, kind, signal) } finally { refresh() }
    })}>{t('settingsRequestPermission')}</Button>
  </SettingsRow>
}
