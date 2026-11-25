import {useRef, useState} from 'react'
import {ActionList, ActionMenu, Button, Stack} from '@primer/react'
import type {NotificationEventType, TemplateVariable} from '../api/notificationTypes'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {SettingsText, SettingsTextarea} from '../settings/SettingsFields'
import {SettingsBand} from '../settings/SettingsPanel'
import {TemplatePreview} from './TemplatePreview'
import {templateError, templateVariables, type RuleDraft} from './ruleDraft'
import {variableDescription} from './variableDescriptions'

export function RuleTemplate({draft, types, device, disabled, change}: {
  draft: RuleDraft; types: NotificationEventType[]; device?: Device; disabled: boolean
  change: (patch: Partial<RuleDraft>) => void
}) {
  const {t} = useLanguage()
  const titleInput = useRef<HTMLInputElement>(null)
  const bodyInput = useRef<HTMLTextAreaElement>(null)
  const previewTrigger = useRef<HTMLButtonElement>(null)
  const [preview, setPreview] = useState(false)
  const variables = templateVariables(types)
  const names = new Set(variables.map(variable => variable.name))
  const titleError = templateError(draft.title, names)
  const bodyError = templateError(draft.body, names)

  function message(error: ReturnType<typeof templateError>) {
    if (error?.syntax) return t('notificationTemplateSyntax')
    if (error?.unknown) return t('notificationTemplateVariableError', {names: error.unknown.join(', ')})
  }

  function insert(field: 'title' | 'body', name: string) {
    const input = field === 'title' ? titleInput.current : bodyInput.current
    const current = draft[field]
    const start = input?.selectionStart ?? current.length
    const end = input?.selectionEnd ?? current.length
    const token = '{{' + name + '}}'
    const next = current.slice(0, start) + token + current.slice(end)
    if (next.length > (field === 'title' ? 256 : 2800)) return
    change({[field]: next})
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return <SettingsBand title={t('notificationTemplate')}>
    <SettingsText label={t('notificationMessageTitle')} value={draft.title} maxLength={256} inputRef={titleInput}
      placeholder="FileSharing" error={message(titleError)} disabled={disabled} onChange={event => change({title: event.target.value})} />
    <Stack direction="horizontal" justify="end">
      <VariableMenu field={t('notificationMessageTitle')} variables={variables} disabled={disabled} insert={name => insert('title', name)} />
    </Stack>
    <SettingsTextarea label={t('notificationMessageBody')} value={draft.body} rows={5} resize="vertical" maxLength={2800} inputRef={bodyInput}
      error={message(bodyError)} disabled={disabled} required onChange={event => change({body: event.target.value})} />
    <Stack direction="horizontal" justify="space-between" gap="condensed" wrap="wrap">
      <Button size="medium" ref={previewTrigger} aria-haspopup="dialog" onClick={() => setPreview(true)}
        disabled={disabled || !types.length || !draft.body.trim() || !!titleError || !!bodyError}>{t('notificationPreview')}</Button>
      <VariableMenu field={t('notificationMessageBody')} variables={variables} disabled={disabled} insert={name => insert('body', name)} />
    </Stack>
    {preview && types.length > 0 && <TemplatePreview draft={draft} types={types} device={device} trigger={previewTrigger}
      close={() => setPreview(false)} />}
  </SettingsBand>
}

function VariableMenu({variables, field, disabled, insert}: {
  variables: TemplateVariable[]; field: string; disabled: boolean; insert: (name: string) => void
}) {
  const {t, locale} = useLanguage()
  return <ActionMenu>
    <ActionMenu.Button size="medium" disabled={disabled || variables.length === 0}
      aria-label={t('notificationVariableTarget', {field})}>{t('notificationInsertVariable')}</ActionMenu.Button>
    <ActionMenu.Overlay align="end" width="medium" maxHeight="large">
      <ActionList>
        {variables.map(variable => <ActionList.Item key={variable.name} onSelect={() => insert(variable.name)}>
          <code>{variable.name}</code>
          <ActionList.Description variant="block">{variableDescription(variable, locale)}</ActionList.Description>
        </ActionList.Item>)}
      </ActionList>
    </ActionMenu.Overlay>
  </ActionMenu>
}
