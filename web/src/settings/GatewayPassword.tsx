import {useRef, useState} from 'react'
import {Button, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {revealGatewayPassword, rotateGatewayPassword, validGatewayPassword, type GatewayAccount} from '../api/gateway'
import {unlock} from '../api/session'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTask} from '../ui/async'
import {SettingsRow, SettingsRows, SettingsText} from './SettingsFields'
import {SettingsBand} from './SettingsPanel'

export function GatewayPassword({account, disabled, rotate}: {
  account: GatewayAccount; disabled: boolean; rotate: (account: GatewayAccount) => void
}) {
  const {t, errorText} = useLanguage()
  const [action, setAction] = useState<'rotate' | 'reveal'>()
  const [value, setValue] = useState('')
  const [password, setPassword] = useState<string>()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const task = useTask()
  const valid = validGatewayPassword(value)
  const title = t(action === 'rotate' ? 'settingsGatewayRotate' : 'settingsGatewayReveal')

  function close() {
    if (task.busy) return
    setAction(undefined)
    setPassword(undefined)
    setValue('')
  }

  function start() {
    if (!valid) return
    void task.run(async signal => {
      if (action === 'rotate') {
        const result = await rotateGatewayPassword(account, value || undefined, signal)
        rotate(result.account)
        setValue('')
        setPassword(result.password)
      } else {
        try { setPassword((await revealGatewayPassword(account.id, signal)).password) }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'fresh_passkey_required') throw error
          await unlock(signal)
          setPassword((await revealGatewayPassword(account.id, signal)).password)
        }
      }
    })
  }

  return <SettingsBand title={t('settingsGatewayPassword')}>
    <SettingsRows>
      <SettingsRow title={t('settingsGatewayPassword')}>
        <Stack direction="horizontal" wrap="wrap" gap="condensed">
          <Button size="medium" disabled={disabled} aria-haspopup="dialog" onClick={event => {
            trigger.current = event.currentTarget
            setAction('rotate')
          }}>{t('settingsGatewayRotate')}</Button>
          <Button size="medium" disabled={disabled || !account.passwordRetrievable} aria-haspopup="dialog" onClick={event => {
            trigger.current = event.currentTarget
            setAction('reveal')
          }}>{t('settingsGatewayReveal')}</Button>
        </Stack>
      </SettingsRow>
    </SettingsRows>
    {action && <Modal title={title} onClose={close} returnFocusRef={trigger} footerButtons={[
      {content: t(password ? 'close' : 'cancel'), size: 'medium', disabled: task.busy, onClick: close},
      ...(!password ? [{content: title, size: 'medium' as const, variant: 'primary' as const, disabled: !valid, loading: task.busy, onClick: start}] : []),
    ]}>
      <Stack gap="normal">
        {password ? <IssuedPassword password={password} /> : action === 'rotate' && <SettingsText label={t('settingsGatewayPassword')}
          caption={t('settingsGatewayPasswordHelp')} error={valid ? undefined : errorText(new ApiError(400, 'invalid_ftp_password'))}
          type="password" autoComplete="new-password" maxLength={128} value={value} disabled={task.busy}
          onChange={event => setValue(event.target.value)} />}
        <ErrorText error={task.error} />
      </Stack>
    </Modal>}
  </SettingsBand>
}

export function IssuedPassword({password}: {password: string}) {
  const {t} = useLanguage()
  return <SettingsText label={t('settingsGatewayPassword')} caption={t('settingsGatewayPasswordIssued')} value={password}
    autoComplete="off" spellCheck={false} readOnly onFocus={event => event.target.select()} />
}
