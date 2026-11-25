import {
  BellIcon, LogIcon, AppsIcon, CpuIcon, DatabaseIcon, DeviceDesktopIcon, GlobeIcon, GraphIcon,
  HistoryIcon, MeterIcon, PlugIcon, PulseIcon, ShieldIcon, type Icon,
} from '@primer/octicons-react'
import type {Message} from '../i18n'

export const categories = {
  overview: {label: 'dataOverview', icon: GraphIcon},
  device: {label: 'dataDevice', icon: DeviceDesktopIcon},
  performance: {label: 'dataPerformance', icon: CpuIcon},
  power: {label: 'dataPower', icon: PlugIcon},
  network: {label: 'dataNetwork', icon: GlobeIcon},
  storage: {label: 'dataStorage', icon: DatabaseIcon},
  applications: {label: 'dataApps', icon: AppsIcon},
  permissions: {label: 'dataPermissions', icon: ShieldIcon},
  events: {label: 'dataEvents', icon: HistoryIcon},
  deliveries: {label: 'notificationDeliveries', icon: BellIcon},
  audit: {label: 'notificationAudit', icon: LogIcon},
} as const

export const logCategories = ['deliveries', 'audit'] as const
export type LogCategory = typeof logCategories[number]
export type Category = keyof typeof categories
export const categoryKeys = Object.keys(categories) as Category[]

export const metricCategories = {
  cpu: {label: 'dataCpu', icon: CpuIcon, category: 'performance'},
  memory: {label: 'dataMemory', icon: MeterIcon, category: 'performance'},
  disk: {label: 'dataDisk', icon: DatabaseIcon, category: 'storage'},
  battery: {label: 'dataBattery', icon: PlugIcon, category: 'power'},
  'connection.quality': {label: 'dataLatency', icon: PulseIcon, category: 'network'},
} as const satisfies Record<string, {label: Message; icon: Icon; category: Category}>

export function dataHref(category: Category = 'overview', options?: {view?: string; inventory?: 'installed'}) {
  if (category === 'overview') return '#data'
  const parameters = new URLSearchParams({section: category})
  if (options?.inventory) parameters.set('inventory', options.inventory)
  if (options?.view) parameters.set('view', options.view)
  return '#data?' + parameters
}

export function categoryFromHash(hash: string): Category {
  const category = new URLSearchParams(hash.split('?')[1]).get('section')
  return category && Object.hasOwn(categories, category) ? category as Category : 'overview'
}
