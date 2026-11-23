import {Button, Stack} from '@primer/react'
import {saveGrant} from '../api/devices'
import type {LocalRoot, Root} from '../api/types'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {ErrorText} from '../ui/Feedback'
import {useTask} from '../ui/async'

interface Props {
  device: string
  local: LocalRoot[]
  roots: Root[]
  refresh: () => void
  close: () => void
}

export function ShareManager({device, local, roots, refresh, close}: Props) {
  const {t} = useLanguage()
  const task = useTask()

  function grant(scope: LocalRoot, root: Root | undefined, writable: boolean) {
    void task.run(async signal => {
      try { await saveGrant(device, scope, root, writable, signal) } finally { refresh() }
    })
  }

  return (
    <Modal title={t('sharedFolders')} onClose={close} footerButtons={[{content: t('close'), size: 'medium', onClick: close}]}>
      <Stack gap="normal">
        {local.length === 0 && <p>{t('emptySharesHelp')}</p>}
        {local.map(scope => {
          const grantRecord = roots.find(root => root.rootKey === scope.rootKey)
          const writable = grantRecord?.writable && scope.writable
          return (
            <Stack key={scope.rootKey} direction="horizontal" align="center" justify="space-between" wrap="wrap" gap="condensed">
              <Stack gap="none">
                <strong>{scope.primary ? t('userFolder') : scope.label}</strong>
                <span>{t(grantRecord?.enabled ? writable ? 'shareWritable' : 'shareReadOnly' : 'shareDisabled')}</span>
              </Stack>
              {!grantRecord?.enabled
                ? <Button size="medium" disabled={task.busy} onClick={() => grant(scope, grantRecord, grantRecord?.writable ?? scope.writable)}>{t('enableShare')}</Button>
                : scope.writable && !writable
                  ? <Button size="medium" disabled={task.busy} onClick={() => grant(scope, grantRecord, true)}>{t('enableWrite')}</Button>
                  : null}
            </Stack>
          )
        })}
        <ErrorText error={task.error} />
      </Stack>
    </Modal>
  )
}
