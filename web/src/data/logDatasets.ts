import type {NotificationDelivery} from '../api/notificationTypes'
import type {AuditRecord} from '../api/settings'
import type {DataObject} from '../api/telemetry'
import type {Locale, Translate} from '../i18n'
import {deliveryLabel, eventName} from '../notifications/notificationLabels'
import {cell, timestampCell, type ReadingDataset} from './readingModel'

export function deliveryValue(delivery: NotificationDelivery, t: Translate): DataObject {
  return {
    ...delivery,
    state: t(deliveryLabel[delivery.state]),
  }
}

export function deliveryDataset(records: NotificationDelivery[], locale: Locale, t: Translate): ReadingDataset {
  return {
    key: 'notification-deliveries',
    title: t('notificationDeliveries'),
    nameTitle: t('notificationEvent'),
    details: true,
    empty: t('notificationNoLogEntries'),
    columns: [
      {key: 'channel', title: t('notificationChannels')},
      {key: 'state', title: t('notificationDeliveryStatus')},
      {key: 'attempts', title: t('notificationAttemptCount')},
      {key: 'occurredAt', title: t('notificationLoggedAt')},
      {key: 'body', title: t('notificationMessageBody')},
    ],
    rows: records.map(item => ({
      id: item.sequence, name: cell(eventName(item.event, locale)), value: deliveryValue(item, t),
      values: {
        channel: cell(item.channelName),
        state: cell(t(deliveryLabel[item.state]), undefined, true),
        attempts: cell(new Intl.NumberFormat(locale).format(item.attempts)),
        occurredAt: timestampCell(item.occurredAt, t),
        body: {text: item.message.body, preview: true},
      },
    })),
    snapshot: records[0] && {observedAt: records[0].updatedAt, stale: false},
  }
}

export function auditDataset(records: AuditRecord[], deviceNames: Map<string, string>, t: Translate): ReadingDataset {
  return {
    key: 'audit',
    title: t('notificationAudit'),
    nameTitle: t('notificationAction'),
    details: true,
    empty: t('notificationNoLogEntries'),
    columns: [
      {key: 'device', title: t('settingsDevice')},
      {key: 'actor', title: t('notificationActor')},
      {key: 'loggedAt', title: t('notificationLoggedAt')},
    ],
    rows: records.map(({id, sequence, time, ...item}) => ({
      id, name: cell(item.action), value: {sequence, loggedAt: time, ...item}, values: {
        device: cell(item.deviceId ? deviceNames.get(item.deviceId) ?? item.deviceId : t('missing')),
        actor: cell(item.actor ?? t('missing')),
        loggedAt: timestampCell(time, t),
      },
    })),
    snapshot: records[0] && {observedAt: records[0].time, stale: false},
  }
}
