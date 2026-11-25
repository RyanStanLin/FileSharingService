import type {NotificationEventType, NotificationRule, RuleInput, TemplateVariable} from '../api/notificationTypes'

export function ruleDraft(rule?: NotificationRule, deviceId = '') {
  return {
    name: rule?.name ?? '',
    enabled: rule?.enabled ?? true,
    deviceId: rule?.deviceId ?? deviceId,
    events: rule?.events ?? [],
    channelIds: rule?.channelIds ?? [],
    cooldown: String(rule?.cooldownSeconds ?? 0),
    bundleId: rule?.filter?.bundleId ?? '',
    applicationId: rule?.filter?.applicationId ?? '',
    storageId: rule?.filter?.storageId ?? '',
    threshold: rule?.filter?.thresholdPercent?.toString() ?? '',
    rootId: rule?.filter?.file?.rootId ?? '',
    path: rule?.filter?.file?.path ?? '',
    nameGlob: rule?.filter?.file?.nameGlob ?? '',
    entryKind: rule?.filter?.file?.entryKind ?? '',
    title: rule?.template.title ?? '',
    body: rule?.template.body ?? '',
  }
}

export type RuleDraft = ReturnType<typeof ruleDraft>

export const hasFileDetails = (types: NotificationEventType[]) =>
  types.some(type => type.filters.includes('file') && type.type !== 'file.directoryChanged')

export function templateVariables(types: NotificationEventType[]): TemplateVariable[] {
  return [...new Map(types.flatMap(type => type.variables).map(variable => [variable.name, variable])).values()]
}

export function wholeNumber(value: string, min: number, max: number) {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max
}

export function buildRule(draft: RuleDraft, types: NotificationEventType[], revision?: number): RuleInput {
  const fields = new Set(types.flatMap(type => type.filters))
  const fileDetails = hasFileDetails(types)
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    deviceId: draft.deviceId,
    events: draft.events,
    channelIds: draft.channelIds,
    cooldownSeconds: Number(draft.cooldown),
    template: {title: draft.title || null, body: draft.body},
    revision,
    filter: {
      bundleId: fields.has('bundleId') ? draft.bundleId.trim() || undefined : undefined,
      applicationId: fields.has('applicationId') ? draft.applicationId.trim() || undefined : undefined,
      storageId: fields.has('storageId') ? draft.storageId.trim() || undefined : undefined,
      thresholdPercent: fields.has('thresholdPercent') ? Number(draft.threshold) : undefined,
      file: fields.has('file') ? {
        rootId: draft.rootId,
        path: draft.path,
        nameGlob: fileDetails ? draft.nameGlob || undefined : undefined,
        entryKind: fileDetails ? draft.entryKind || undefined : undefined,
      } : undefined,
    },
  }
}

export function variablesIn(text: string) {
  return [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(match => match[1].trim())
}

export function templateError(text: string, allowed: Set<string>) {
  const variables = variablesIn(text)
  if (variables.length > 48 || /\{\{|\}\}/.test(text.replace(/\{\{[\s\S]*?\}\}/g, ''))) return {syntax: true}
  const unknown = [...new Set(variables.filter(value => !allowed.has(value)))]
  return unknown.length ? {unknown} : undefined
}
