import {
  AppsIcon, ArrowSwitchIcon, DatabaseIcon, DeviceDesktopIcon, GearIcon,
  GlobeIcon, HistoryIcon, PasteIcon, PulseIcon, TasklistIcon, type Icon,
} from '@primer/octicons-react'
import {activityTopics, type ActivityTopic} from '../api/telemetry'
import type {Message} from '../i18n'

export type EventView = ActivityTopic | 'all'

export const eventViews = ['all', ...activityTopics] as const

export const eventCategories = {
  all: {label: 'dataAllEvents', icon: HistoryIcon},
  'connection.changed': {label: 'dataConnection', icon: GlobeIcon},
  'applications.changed': {label: 'dataApplicationEvent', icon: AppsIcon},
  'storage.changed': {label: 'dataStorageEvent', icon: DatabaseIcon},
  'system.changed': {label: 'dataSystemEvent', icon: GearIcon},
  'lid.changed': {label: 'dataLidEvent', icon: DeviceDesktopIcon},
  'clipboard.changed': {label: 'dataClipboardEvent', icon: PasteIcon},
  'telemetry.gap': {label: 'dataGapEvent', icon: PulseIcon},
  'jobs.changed': {label: 'dataJobEvent', icon: TasklistIcon},
  'transfers.changed': {label: 'dataTransferEvent', icon: ArrowSwitchIcon},
} as const satisfies Record<EventView, {label: Message; icon: Icon}>

export function eventViewFromQuery(view: string | null): EventView {
  return eventViews.find(category => category === view) ?? 'all'
}
