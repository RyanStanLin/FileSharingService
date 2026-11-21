import {Button, Stack} from '@primer/react'
import {ShieldIcon} from '@primer/octicons-react'
import {requestPermission} from '../api/devices'
import type {Device, Permission, PermissionKind} from '../api/types'
import {useLanguage} from '../i18n'
import {useTask} from '../ui/async'
import {State} from '../ui/Feedback'

export function PermissionView({device, kind, permission, refresh, displayName}: {
  device: Device
  kind: PermissionKind
  permission?: Permission
  refresh: () => void
  displayName: string
}) {
  const {t} = useLanguage()
  const task = useTask()
  const pending = task.busy || permission?.phase === 'requesting'
  const needsSettings = permission?.state === 'denied' || permission?.state === 'requiresSystemSettings'
  return (
    <State title={t('permissionTitle', {name: displayName})} error={task.error}
      description={pending ? t('permissionPrompt', {device: device.name}) : t(permission?.state ?? 'unknown')}>
      <Stack align="center" gap="condensed">
        {needsSettings && <p>{t('permissionSettings')}</p>}
        <Button size="medium" variant="primary" leadingVisual={ShieldIcon} loading={pending}
          onClick={() => void task.run(async signal => {
            try { await requestPermission(device.id, kind, signal) } finally { refresh() }
          })}>
          {t(pending ? 'requesting' : 'permissionRequest')}
        </Button>
      </Stack>
    </State>
  )
}
