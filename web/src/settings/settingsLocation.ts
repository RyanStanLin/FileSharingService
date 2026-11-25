const sections = ['general', 'reporting', 'fileAccess', 'profiles', 'channels', 'gateway', 'preferences'] as const
export type SettingsSection = typeof sections[number]

export function settingsLocation(hash: string) {
  const parameters = new URLSearchParams(hash.split('?')[1])
  const section = sections.find(value => value === parameters.get('section')) ?? 'general'
  return {section, item: parameters.get('item') ?? undefined}
}

export function settingsHref(section: SettingsSection = 'general', item?: string) {
  const parameters = new URLSearchParams({section})
  if (item) parameters.set('item', item)
  return '#settings?' + parameters
}

export function subscriptionHref(rule?: string) {
  return rule ? '#subscriptions?' + new URLSearchParams({rule}) : '#subscriptions'
}

export const NEW_ITEM = 'new'
