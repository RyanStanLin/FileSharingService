import {useId, useState, type RefObject} from 'react'
import {FormControl, Stack, TextInput} from '@primer/react'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {ErrorText} from '../ui/Feedback'

export function SetupDialog({submit, close, busy, error, returnFocusRef}: {
  submit: (secret: string) => void
  close: () => void
  busy: boolean
  error: unknown
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const {t} = useLanguage()
  const [secret, setSecret] = useState('')
  const form = useId()
  return (
    <Modal title={t('setup')} subtitle={t('setupHelp')} onClose={() => { if (!busy) close() }}
      returnFocusRef={returnFocusRef} footerButtons={[
        {content: t('cancel'), size: 'medium', onClick: close, disabled: busy},
        {content: t('unlock'), size: 'medium', buttonType: 'primary', type: 'submit', form, loading: busy},
      ]}>
      <Stack as="form" id={form} gap="condensed" onSubmit={(event: React.FormEvent) => {
        event.preventDefault()
        if (!busy) submit(secret)
      }}>
        <FormControl required>
          <FormControl.Label>{t('setupSecret')}</FormControl.Label>
          <TextInput size="medium" block type="password" autoComplete="off" value={secret}
            onChange={event => setSecret(event.target.value)} disabled={busy} />
        </FormControl>
        <ErrorText error={error} />
      </Stack>
    </Modal>
  )
}
