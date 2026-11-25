import {query, readAll, request, send} from './client'
import type {
  ChannelInput, DeliveryState, NotificationCatalog, NotificationChannel, NotificationDelivery, NotificationRule,
  NotificationWatch, RuleInput,
} from './notificationTypes'

const base = '/notifications'
const channelRoute = base + '/channels'
const ruleRoute = base + '/rules'
const itemRoute = (route: string, id: string) => route + '/' + encodeURIComponent(id)

export const readChannels = (signal: AbortSignal) => readAll<NotificationChannel>(channelRoute, signal)
export const readCatalog = (signal: AbortSignal) => request<NotificationCatalog>(base + '/event-types', {signal})
export const readRules = (signal: AbortSignal) => readAll<NotificationRule>(ruleRoute, signal)
export const readWatches = (signal: AbortSignal) => request<NotificationWatch[]>(base + '/watches', {signal})

export const saveChannel = (id: string | undefined, input: ChannelInput, signal: AbortSignal) =>
  send<NotificationChannel>(id ? itemRoute(channelRoute, id) : channelRoute, id ? 'PUT' : 'POST', input, {signal})

export const deleteChannel = (channel: NotificationChannel, signal: AbortSignal) =>
  send<void>(query(itemRoute(channelRoute, channel.id), {revision: channel.revision}), 'DELETE', undefined, {signal})

export const verifyChannel = (id: string, signal: AbortSignal) =>
  send<{botId: string; botUsername: string | null; chatId: string; chatType: string}>(
    itemRoute(channelRoute, id) + '/verify', 'POST', undefined, {signal})

export const testChannel = (id: string, key: string, input: {title?: string; body?: string}, signal: AbortSignal) =>
  send<NotificationDelivery>(itemRoute(channelRoute, id) + '/test', 'POST', input, {signal, headers: {'Idempotency-Key': key}})

export const saveRule = (id: string | undefined, input: RuleInput, signal: AbortSignal) =>
  send<NotificationRule>(id ? itemRoute(ruleRoute, id) : ruleRoute, id ? 'PUT' : 'POST', input, {signal})

export const deleteRule = (rule: NotificationRule, signal: AbortSignal) =>
  send<void>(query(itemRoute(ruleRoute, rule.id), {revision: rule.revision}), 'DELETE', undefined, {signal})

export const previewRule = (event: string, events: string[], template: RuleInput['template'], context: Record<string, string>,
  signal: AbortSignal) => send<{message: NotificationDelivery['message']; missingVariables: string[]}>(
  ruleRoute + '/preview', 'POST', {event, events, template, context}, {signal})

export const readDelivery = (id: string, signal: AbortSignal) =>
  request<NotificationDelivery>(itemRoute(base + '/deliveries', id), {signal})

export interface DeliveryFilters {
  channelId?: string
  ruleId?: string
  deviceId?: string
  state?: DeliveryState
}

export async function readDeliveries(filters: DeliveryFilters, after: string | undefined, signal: AbortSignal) {
  const page = await request<{items: NotificationDelivery[]; cursor: string; hasMore: boolean}>(
    query(base + '/deliveries', {...filters, after, limit: 50, descending: true}), {signal})
  return {items: page.items, nextCursor: page.hasMore ? page.cursor : null}
}
