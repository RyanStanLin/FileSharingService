import {useState} from 'react'
import {Link} from '@primer/react'
import {deleteRule, readRules, readWatches, saveRule} from '../api/notifications'
import type {NotificationCatalog, NotificationChannel, NotificationRule} from '../api/notificationTypes'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {DeleteSetting} from '../settings/DeleteSetting'
import {SettingsRow, SettingsRows} from '../settings/SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from '../settings/SettingsPanel'
import {subscriptionHref} from '../settings/settingsLocation'
import {useRefresh, useResource, useTask} from '../ui/async'
import {RuleChoices} from './RuleChoices'
import {RuleFilters} from './RuleFilters'
import {RuleRuntime} from './RuleRuntime'
import {RuleTemplate} from './RuleTemplate'
import {buildRule, ruleDraft, templateError, templateVariables, wholeNumber, type RuleDraft} from './ruleDraft'

interface Props {
  rule?: NotificationRule
  device?: Device
  devices: Device[]
  channels: NotificationChannel[]
  catalog: NotificationCatalog
  refresh: () => void
  refreshDevices: () => void
  created: boolean
  onCreated: (id: string) => void
}

export function RuleEditor({rule, device, devices, channels, catalog, refresh, refreshDevices, created, onCreated}: Props) {
  const {t} = useLanguage()
  const [base, setBase] = useState(rule)
  const [draft, setDraft] = useState(() => ruleDraft(rule, device?.id))
  const [attempted, setAttempted] = useState(false)
  const [saved, setSaved] = useState(created)
  const task = useTask()
  const types = catalog.events.filter(type => draft.events.includes(type.type))
  const allowed = new Set(templateVariables(types).map(variable => variable.name))
  const dirty = !base || JSON.stringify(draft) !== JSON.stringify(ruleDraft(base))
  const fields = new Set(types.flatMap(type => type.filters))
  const chosenDevice = devices.find(item => item.id === draft.deviceId)
  const watchKey = base?.filter?.file ? base.id : null
  const watches = useResource(watchKey, readWatches)
  useRefresh(!!watchKey, watches.refresh, 5000)
  const latestRule = rule?.id === base?.id && (rule?.revision ?? 0) >= (base?.revision ?? 0) ? rule : base

  function show(updated: NotificationRule) {
    setBase(updated)
    setDraft(ruleDraft(updated))
    setAttempted(false)
  }

  function apply() {
    setAttempted(true)
    if (!draft.name.trim() || !chosenDevice || !types.length || types.length !== draft.events.length ||
      !draft.channelIds.length || !wholeNumber(draft.cooldown, 0, 86400) || !draft.body.trim() ||
      fields.has('file') && !draft.rootId || fields.has('thresholdPercent') && !wholeNumber(draft.threshold, 1, 100) ||
      templateError(draft.title, allowed) || templateError(draft.body, allowed)) return
    void task.run(async signal => {
      const updated = await saveRule(base?.id, buildRule(draft, types, base?.revision), signal)
      show(updated)
      if (!base) onCreated(updated.id)
      setSaved(true)
      refresh()
      watches.refresh()
    })
  }

  const fieldsProps = {
    draft, disabled: task.busy, attempted, change: (patch: Partial<RuleDraft>) => setDraft(previous => ({...previous, ...patch})),
  }
  return <SettingsPanel title={base?.name ?? t('notificationNewRule')} description={t('notificationRulesHelp')}
    actions={<Link href={subscriptionHref()}>{t('notificationAllRules')}</Link>}
    notice={!!(task.error || (saved && !dirty)) && <SettingsNotice error={task.error} saved={saved && !dirty} reload={base && (() => void task.run(async signal => {
        const latest = (await readRules(signal)).find(item => item.id === base.id)
        if (latest) show(latest)
        else window.location.hash = subscriptionHref()
        setSaved(false)
      }))} />}
    busy={task.busy} disabled={!dirty} onApply={apply}>
    <RuleChoices {...fieldsProps} devices={devices} catalog={catalog} channels={channels} refresh={refreshDevices} />
    <RuleFilters {...fieldsProps} types={types} />
    <RuleTemplate {...fieldsProps} types={types} device={chosenDevice} />
    {latestRule && <RuleRuntime rule={latestRule} watches={watches.data} watchError={watches.error} />}
    {base && <SettingsBand title={t('settingsManagement')}>
      <SettingsRows>
        <SettingsRow title={t('notificationDeleteRule')}>
          <DeleteSetting title={t('notificationDeleteRule')} description={t('notificationDeleteRuleHelp', {name: base.name})}
            disabled={task.busy} remove={async signal => {
              await deleteRule(base, signal)
              refresh()
              window.location.hash = subscriptionHref()
            }} />
        </SettingsRow>
      </SettingsRows>
    </SettingsBand>}
  </SettingsPanel>
}
