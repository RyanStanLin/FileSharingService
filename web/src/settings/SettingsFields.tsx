import {useId, type ReactNode, type Ref} from 'react'
import {FormControl, Stack, TextInput, Textarea, ToggleSwitch, type TextInputProps, type TextareaProps} from '@primer/react'
import {useLanguage} from '../i18n'
import styles from './settings.module.css'

export function SettingsRows({children}: {children: ReactNode}) {
  return <div className={styles.rows}>{children}</div>
}

export function SettingsRow({title, description, children}: {title: ReactNode; description?: ReactNode; children: ReactNode}) {
  return <Stack direction="horizontal" justify="space-between" align="center" wrap="wrap" gap="condensed" className={styles.row}>
    <div className={styles.rowText}>
      <div>{title}</div>
      {description && <div className={styles.caption}>{description}</div>}
    </div>
    {children && <div className={styles.rowControls}>{children}</div>}
  </Stack>
}

export function SettingsSwitch({title, description, checked, onChange, disabled, loading, size = 'small'}: {
  title: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean
  loading?: boolean; size?: 'small' | 'medium'
}) {
  const id = useId()
  const hint = useId()
  const {t} = useLanguage()
  return <SettingsRow title={<span id={id}>{title}</span>} description={description && <span id={hint}>{description}</span>}>
    <ToggleSwitch size={size} checked={checked} onChange={onChange} disabled={disabled} loading={loading}
      aria-labelledby={id} aria-describedby={description ? hint : undefined} statusLabelPosition="start"
      buttonLabelOn={t('on')} buttonLabelOff={t('off')} loadingLabel={t('loading')} />
  </SettingsRow>
}

export function SettingsText({label, caption, error, children, inputRef, ...input}: TextInputProps & {
  label: string; caption?: string; error?: string; children?: ReactNode; inputRef?: Ref<HTMLInputElement>
}) {
  return <FormControl required={input.required} disabled={input.disabled}>
    <FormControl.Label>{label}</FormControl.Label>
    <TextInput {...input} ref={inputRef} className={styles.textInput} size="medium" block validationStatus={error ? 'error' : undefined} />
    {caption && <FormControl.Caption>{caption}</FormControl.Caption>}
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
    {children}
  </FormControl>
}

export function SettingsTextarea({label, error, inputRef, ...input}: TextareaProps & {
  label: string; error?: string; inputRef?: Ref<HTMLTextAreaElement>
}) {
  return <FormControl required={input.required} disabled={input.disabled}>
    <FormControl.Label>{label}</FormControl.Label>
    <Textarea {...input} ref={inputRef} block validationStatus={error ? 'error' : undefined} />
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
  </FormControl>
}
