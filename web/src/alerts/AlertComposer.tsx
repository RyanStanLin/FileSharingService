import {useId, useRef, useState, type FormEvent, type RefObject} from 'react'
import {Button, ButtonGroup, Dialog, Heading, IconButton, type DialogHeaderProps} from '@primer/react'
import {PaperAirplaneIcon, XIcon} from '@primer/octicons-react'
import {pushAlert, type AlertJob} from '../api/alerts'
import {useLanguage} from '../i18n'
import {useTask} from '../ui/async'
import {ErrorText} from '../ui/Feedback'
import {AlertInput, ButtonEditor, choiceLabelId, fieldHintId, TextFieldEditor} from './AlertEditors'
import {alertPayload, alertTextError, choiceLimit, fieldLimit, newChoice, newField, textLimits, type AlertDraft} from './alertDraft'
import styles from './composer.module.css'

function ComposerHeading({title, dialogLabelId, onClose}: DialogHeaderProps) {
  const {t} = useLanguage()
  return <div className={styles.heading}>
    <Heading as="h2" id={dialogLabelId} className={styles.title}>{title}</Heading>
    <IconButton type="button" size="medium" variant="invisible" icon={XIcon} aria-label={t('close')}
      onClick={() => onClose('close-button')} />
  </div>
}

export function AlertComposer({deviceId, initial, enabled, returnFocusRef, close, queued}: {
  deviceId: string
  initial: AlertDraft
  enabled: boolean
  returnFocusRef: RefObject<HTMLButtonElement | null>
  close: () => void
  queued: (job: AlertJob, title: string) => void
}) {
  const {t} = useLanguage()
  const [draft, setDraft] = useState(initial)
  const [validate, setValidate] = useState(false)
  const task = useTask()
  const formId = useId()
  const form = useRef<HTMLFormElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const addFieldButton = useRef<HTMLButtonElement>(null)
  const addChoiceButton = useRef<HTMLButtonElement>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!enabled || task.busy) return
    setValidate(true)
    const invalid = alertTextError(t, draft.title, textLimits.title, true) ||
      alertTextError(t, draft.message, textLimits.message, true, true) ||
      draft.fields.some(field => alertTextError(t, field.hintText, textLimits.hint) || alertTextError(t, field.defaultText, textLimits.prefill)) ||
      draft.choices.some(choice => alertTextError(t, choice.label, textLimits.button, true))
    if (invalid) {
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    const body = alertPayload(draft)
    void task.run(async signal => {
      const job = await pushAlert(deviceId, body, signal)
      if (!signal.aborted) queued(job, body.title)
    })
  }

  function focusInput(id: string) {
    requestAnimationFrame(() => form.current && document.getElementById(id)?.focus())
  }

  function addField() {
    const field = newField()
    setDraft(current => ({...current, fields: [...current.fields, field]}))
    focusInput(fieldHintId(field))
  }

  function addButton() {
    const choice = newChoice()
    setDraft(current => ({...current, choices: [...current.choices, choice]}))
    focusInput(choiceLabelId(choice))
  }

  return <Dialog title={t('alertComposer')} width="large" className={styles.dialog} returnFocusRef={returnFocusRef}
    initialFocusRef={titleInput} onClose={() => { if (!task.busy) close() }} renderHeader={ComposerHeading}
    renderBody={() => <form autoComplete="off" id={formId} ref={form} onSubmit={submit} noValidate>
      <fieldset className={styles.formFields} disabled={task.busy}>
        <div className={styles.message}>
          <AlertInput label="alertTitle" placeholder="alertTitle" inputRef={titleInput} value={draft.title} required
            onChange={title => setDraft(current => ({...current, title}))} validate={validate} maximum={textLimits.title} />
          <AlertInput label="alertSubtitle" placeholder="alertSubtitle" value={draft.message} required multiline
            onChange={message => setDraft(current => ({...current, message}))} validate={validate} maximum={textLimits.message} />
        </div>
        <div className={styles.editors}>
          {draft.fields.map((field, index) => <TextFieldEditor key={field.id} field={field} number={index + 1} validate={validate}
            change={next => setDraft(current => ({...current, fields: current.fields.map(item => item.id === field.id ? next : item)}))}
            remove={() => {
              const fields = draft.fields.filter(item => item.id !== field.id)
              setDraft(current => ({...current, fields}))
              const next = fields[Math.min(index, fields.length - 1)]
              if (next) focusInput(fieldHintId(next))
              else requestAnimationFrame(() => addFieldButton.current?.focus())
            }} />)}
          {draft.choices.map((choice, index) => <ButtonEditor key={choice.id} choice={choice} number={index + 1}
            primary={draft.primaryId === choice.id} validate={validate}
            change={label => setDraft(current => ({...current, choices: current.choices.map(item => item.id === choice.id ? {...item, label} : item)}))}
            setPrimary={checked => setDraft(current => ({...current, primaryId: checked ? choice.id : undefined}))}
            remove={index === 0 ? undefined : () => {
              const choices = draft.choices.filter(item => item.id !== choice.id)
              setDraft(current => ({...current, choices, primaryId: current.primaryId === choice.id ? undefined : current.primaryId}))
              focusInput(choiceLabelId(choices[Math.min(index, choices.length - 1)]))
            }} />)}
        </div>
      </fieldset>
    </form>}
    renderFooter={() => <div className={styles.footer}>
      {(Boolean(task.error) || !enabled) && <div className={styles.feedback}>
        <ErrorText error={task.error} />
        {!enabled && <div role="status">{t('alertComposeUnavailable')}</div>}
      </div>}
      <ButtonGroup>
        <Button ref={addFieldButton} type="button" size="medium" onClick={addField}
          disabled={task.busy || draft.fields.length >= fieldLimit || draft.requireLocalAuthentication}>{t('alertAddField')}</Button>
        <Button ref={addChoiceButton} type="button" size="medium" onClick={addButton}
          disabled={task.busy || draft.choices.length >= choiceLimit}>{t('alertAddButton')}</Button>
      </ButtonGroup>
      <Button form={formId} type="submit" variant="primary" size="medium" leadingVisual={PaperAirplaneIcon}
        loading={task.busy} disabled={!enabled}>{t('alertPush')}</Button>
    </div>} />
}
