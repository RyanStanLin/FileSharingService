import {useId, type ReactNode, type RefObject} from 'react'
import {FormControl, IconButton, TextInput, ToggleSwitch} from '@primer/react'
import {TrashIcon} from '@primer/octicons-react'
import type {AlertChoice} from '../api/alerts'
import {useLanguage, type Message} from '../i18n'
import {alertTextError, textLimits, type DraftField} from './alertDraft'
import styles from './composer.module.css'

export function AlertInput({id, label, placeholder, value, onChange, validate, maximum, inputRef, required, requiredIndicator, masked, multiline}: {
  id?: string
  label: Message
  placeholder: Message
  value: string
  onChange: (value: string) => void
  validate: boolean
  maximum: number
  inputRef?: RefObject<HTMLInputElement | null>
  required?: boolean
  requiredIndicator?: boolean
  masked?: boolean
  multiline?: boolean
}) {
  const {t} = useLanguage()
  const error = validate ? alertTextError(t, value, maximum, required, multiline) : undefined
  return <FormControl id={id} required={required}>
    <FormControl.Label className={styles.inputLabel} requiredText={requiredIndicator === false ? '' : undefined}
      requiredIndicator={requiredIndicator}>{t(label)}</FormControl.Label>
    <TextInput ref={inputRef} size="large" block type={masked ? 'password' : 'text'} autoComplete="off"
      value={value} placeholder={t(placeholder)} onChange={event => onChange(event.target.value)} />
    {error && <FormControl.Validation variant="error">{error}</FormControl.Validation>}
  </FormControl>
}

function Option({label, description, checked, onChange}: {
  label: Message; description: Message; checked: boolean; onChange: (checked: boolean) => void
}) {
  const {t} = useLanguage()
  const id = useId()
  const caption = `${id}-caption`
  return <div className={styles.option}>
    <div>
      <div id={id}>{t(label)}</div>
      <div id={caption} className={styles.caption}>{t(description)}</div>
    </div>
    <ToggleSwitch size="small" aria-labelledby={id} aria-describedby={caption} statusLabelPosition="start"
      buttonLabelOn={t('on')} buttonLabelOff={t('off')} checked={checked} onChange={onChange} />
  </div>
}

function Editor({label, action, children}: {label: string; action: ReactNode; children: ReactNode}) {
  const id = useId()
  return <section aria-labelledby={id} className={styles.editor}>
    <div className={styles.editorHeader}>
      <h3 id={id}>{label}</h3>
      {action}
    </div>
    {children}
  </section>
}

export const fieldHintId = (field: DraftField) => `alert-hint-${field.id}`
export const choiceLabelId = (choice: AlertChoice) => `alert-choice-${choice.id}`

export function TextFieldEditor({field, number, change, remove, validate}: {
  field: DraftField; number: number; change: (field: DraftField) => void; remove: () => void; validate: boolean
}) {
  const {t} = useLanguage()
  return <Editor label={t('alertFieldNumber', {number})} action={
    <IconButton type="button" icon={TrashIcon} size="medium" variant="invisible"
      aria-label={t('alertRemoveField', {number})} onClick={remove} />
  }>
    <AlertInput id={fieldHintId(field)} label="alertHint" placeholder="alertHintPlaceholder" value={field.hintText}
      onChange={hintText => change({...field, hintText})} validate={validate} maximum={textLimits.hint} />
    <AlertInput label="alertPrefill" placeholder="alertText" value={field.defaultText} masked={field.maskText}
      onChange={defaultText => change({...field, defaultText})} validate={validate} maximum={textLimits.prefill} />
    <div className={styles.options}>
      <Option label="alertFieldRequired" description="alertFieldRequiredHelp" checked={field.required}
        onChange={required => change({...field, required})} />
      <Option label="alertFieldDisabled" description="alertFieldDisabledHelp" checked={field.disabled}
        onChange={disabled => change({...field, disabled})} />
      <Option label="alertFieldMask" description="alertFieldMaskHelp" checked={field.maskText}
        onChange={maskText => change({...field, maskText})} />
    </div>
  </Editor>
}

export function ButtonEditor({choice, number, primary, change, setPrimary, remove, validate}: {
  choice: AlertChoice; number: number; primary: boolean; change: (value: string) => void
  setPrimary: (checked: boolean) => void; remove?: () => void; validate: boolean
}) {
  const {t} = useLanguage()
  return <Editor label={t('alertButtonNumber', {number})} action={remove
    ? <IconButton type="button" icon={TrashIcon} size="medium" variant="invisible"
        aria-label={t('alertRemoveButton', {number})} onClick={remove} />
    : <span className={styles.required}>{t('alertFieldRequired')}</span>
  }>
    <AlertInput id={choiceLabelId(choice)} label="alertButtonText" placeholder="alertText" value={choice.label}
      onChange={change} validate={validate} maximum={textLimits.button} required requiredIndicator={false} />
    <div className={styles.options}>
      <Option label="alertPrimary" description="alertPrimaryHelp" checked={primary} onChange={setPrimary} />
    </div>
  </Editor>
}
