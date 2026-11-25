export interface NotificationChannel {
  id: string
  name: string
  kind: 'bark' | 'telegram'
  enabled: boolean
  revision: number
  createdAt: string
  updatedAt: string
  credentialConfigured: boolean
  bark: {server: string; group: string | null; sound: string | null; level: string | null} | null
  telegram: {chatId: string; messageThreadId: number | null; silent: boolean} | null
}

export interface ChannelInput {
  name: string
  kind: NotificationChannel['kind']
  enabled: boolean
  revision?: number
  bark?: {server?: string; deviceKey?: string; group?: string; sound?: string; level?: string}
  telegram?: {chatId: string; botToken?: string; messageThreadId?: number; silent: boolean}
}

export interface TemplateVariable {
  name: string
  description: string
}

export interface NotificationEventType {
  type: string
  description: string
  variables: TemplateVariable[]
  filters: string[]
}

export interface NotificationCatalog {
  events: NotificationEventType[]
  credentialsEnabled: boolean
  maximumRules: number
  maximumChannels: number
  maximumChannelsPerRule: number
  maximumDirectoriesPerDevice: number
}

export interface FileFilter {
  rootId: string
  path: string
  nameGlob?: string | null
  entryKind?: string | null
}

export interface NotificationFilter {
  bundleId?: string | null
  applicationId?: string | null
  storageId?: string | null
  thresholdPercent?: number | null
  file?: FileFilter | null
}

export interface RuleInput {
  name: string
  deviceId: string
  enabled: boolean
  events: string[]
  channelIds: string[]
  filter?: NotificationFilter
  cooldownSeconds: number
  template: {title: string | null; body: string}
  revision?: number
}

export interface NotificationRule extends RuleInput {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  matchedEvents: number
  enqueuedDeliveries: number
  skippedDeliveries: number
  lastMatchedAt: string | null
}

export interface NotificationWatch {
  deviceId: string
  rootId: string
  path: string
  ruleIds: string[]
  state: 'checking' | 'starting' | 'active' | 'waitingForConnection' | 'awaitingAuthorization' | 'unavailable'
  checkedAt: string | null
  error: string | null
}

export const deliveryStates = ['queued', 'sending', 'retryScheduled', 'sent', 'failed', 'cancelled'] as const
export type DeliveryState = typeof deliveryStates[number]

export interface NotificationDelivery {
  id: string
  sequence: string
  channelId: string
  channelName: string
  channelKind: NotificationChannel['kind']
  ruleId: string | null
  deviceId: string | null
  rootId: string | null
  event: string
  sourceSequence: string | null
  occurredAt: string
  context: Record<string, string> | null
  message: {title: string; body: string}
  state: DeliveryState
  attempts: number
  createdAt: string
  updatedAt: string
  nextAttemptAt: string | null
  error: string | null
  httpStatus: number | null
  providerId: string | null
}

export interface NotificationUpdate {
  resource: string
  id: string
  action: string
  state?: DeliveryState
}
