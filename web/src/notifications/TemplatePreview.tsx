import {useState, type RefObject} from 'react'
import {Button, Heading, Stack} from '@primer/react'
import {previewRule} from '../api/notifications'
import type {NotificationEventType} from '../api/notificationTypes'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {SettingsText} from '../settings/SettingsFields'
import styles from '../settings/settings.module.css'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource} from '../ui/async'
import {eventName} from './notificationLabels'
import {variablesIn, type RuleDraft} from './ruleDraft'
import {variableDescription} from './variableDescriptions'

export function TemplatePreview({draft, types, device, trigger, close}: {
  draft: RuleDraft; types: NotificationEventType[]; device?: Device
  trigger: RefObject<HTMLButtonElement | null>; close: () => void
}) {
  const {t, locale} = useLanguage()
  const [event, setEvent] = useState(types[0].type)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState<Record<string, string>>({})
  const type = types.find(candidate => candidate.type === event) ?? types[0]
  const used = new Set([...variablesIn(draft.title), ...variablesIn(draft.body)])
  const variables = type.variables.filter(variable => !variable.name.startsWith('event.') && used.has(variable.name))
  const defaults: Record<string, string | undefined> = {
    'device.id': device?.id, 'device.name': device?.name,
    'app.bundleId': draft.bundleId || undefined, 'app.id': draft.applicationId || undefined,
    'storage.id': draft.storageId || undefined, 'metric.thresholdPercent': draft.threshold || undefined,
    'directory.rootId': draft.rootId || undefined, 'directory.path': draft.rootId ? draft.path : undefined,
  }
  const values = Object.fromEntries(variables.flatMap(({name}) => {
    const value = overrides[name] ?? defaults[name]
    return value === undefined ? [] : [[name, value]]
  }))
  const preview = useResource(JSON.stringify([type.type, submitted]), signal => {
    const context = Object.fromEntries(variables.flatMap(({name}) => {
      const value = submitted[name] ?? defaults[name]
      return value === undefined ? [] : [[name, value]]
    }))
    return previewRule(type.type, types.map(candidate => candidate.type), {title: draft.title || null, body: draft.body}, context, signal)
  })

  return <Modal title={t('notificationPreview')} subtitle={t('notificationPreviewHelp')} returnFocusRef={trigger} onClose={close}
    footerButtons={[{content: t('close'), size: 'medium', onClick: close}]}>
    <Stack gap="normal">
      <ChoiceMenu label={t('notificationPreviewEvent')} value={type.type} block
        options={types.map(candidate => ({value: candidate.type, label: eventName(candidate.type, locale)}))}
        onChange={value => { setEvent(value); setSubmitted(overrides) }} />
      {preview.pending && <Loading />}
      <ErrorText error={preview.error} />
      {preview.data && <>
        <Heading as="h3" className={styles.subheading}>{preview.data.message.title}</Heading>
        <p className={styles.message}>{preview.data.message.body}</p>
        {preview.data.missingVariables.length > 0 && <p className={styles.caption}>
          {t('notificationMissingVariables', {names: preview.data.missingVariables.join(', ')})}
        </p>}
      </>}
      {variables.length > 0 && <>
        <Heading as="h3" className={styles.subheading}>{t('notificationSampleValues')}</Heading>
        {variables.map(variable => <SettingsText key={variable.name} label={variable.name} caption={variableDescription(variable, locale)}
          maxLength={3000} value={values[variable.name] ?? ''} onChange={change => setOverrides({...overrides, [variable.name]: change.target.value})} />)}
        <div><Button size="medium" onClick={() => { setSubmitted(overrides); preview.refresh() }}>{t('notificationPreview')}</Button></div>
      </>}
    </Stack>
  </Modal>
}
