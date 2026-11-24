import type {AlertChoice, AlertDetail, AlertRequest} from '../api/alerts'
import type {Translate} from '../i18n'

export const fieldLimit = 6
export const choiceLimit = 3

export const textLimits = {title: 100, message: 1000, hint: 120, prefill: 1024, button: 40}

export type DraftField = NonNullable<AlertRequest['textFields']>[number] & {hintText: string}

export interface AlertDraft {
  title: string
  message: string
  fields: DraftField[]
  choices: AlertChoice[]
  primaryId?: string
  requireLocalAuthentication?: boolean
}

function identifier() {
  return crypto.randomUUID().replaceAll('-', '')
}

export function newField(): DraftField {
  return {id: identifier(), hintText: '', defaultText: '', required: true, disabled: false, maskText: true}
}

export function newChoice(): AlertChoice {
  return {id: identifier(), label: ''}
}

export function newAlert(): AlertDraft {
  const choice = newChoice()
  return {title: '', message: '', fields: [newField()], choices: [choice], primaryId: choice.id}
}

export function draftFromRecord({request, result}: AlertDetail): AlertDraft | undefined {
  if (!request) return
  const {title, message, choices, askText, maskText, textRequired, textFields} = request
  if (!choices.length) return
  const fields = textFields?.map(field => ({...field, hintText: field.hintText ?? '', defaultText: ''}))
    ?? (askText ? [{...newField(), required: textRequired, maskText}] : [])
  const primaryId = choices.some(choice => choice.isPrimary != null)
    ? choices.find(choice => choice.isPrimary)?.id : choices[0].id
  return {title, message, choices, fields, primaryId,
    requireLocalAuthentication: request.requireLocalAuthentication || result.locallyAuthenticated}
}

export function alertPayload(draft: AlertDraft): AlertRequest {
  const choices = draft.choices.map(choice => ({id: choice.id, label: choice.label.trim(), isPrimary: choice.id === draft.primaryId}))
  const primary = choices.find(choice => choice.isPrimary)
  return {
    title: draft.title.trim(), message: draft.message.trim(),
    choices: primary ? [primary, ...choices.filter(choice => choice !== primary)] : choices,
    textFields: draft.fields.length ? draft.fields : undefined,
    requireLocalAuthentication: draft.requireLocalAuthentication,
  }
}

export function alertTextError(t: Translate, value: string, maximum: number, required = false, multiline = false) {
  const text = required ? value.trim() : value
  if (required && !text) return t('alertRequiredError')
  if (text.length > maximum) return t('alertLengthError', {maximum})
  const check = multiline ? text.replaceAll('\n', '') : text
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(check)) return t('alertCharactersError')
}
