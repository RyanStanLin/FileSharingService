import {
  AppsIcon, CpuIcon, DatabaseIcon, DeviceDesktopIcon, GlobeIcon, GraphIcon,
  HistoryIcon, MeterIcon, PlugIcon, PulseIcon, ShieldIcon, type Icon,
} from '@primer/octicons-react'
import type {Message} from '../i18n'

export const categories = {
  overview: {label: 'dataOverview', icon: GraphIcon, tone: 'blue'},
  device: {label: 'dataDevice', icon: DeviceDesktopIcon, tone: 'purple'},
  performance: {label: 'dataPerformance', icon: CpuIcon, tone: 'orange'},
  power: {label: 'dataPower', icon: PlugIcon, tone: 'green'},
  network: {label: 'dataNetwork', icon: GlobeIcon, tone: 'blue'},
  storage: {label: 'dataStorage', icon: DatabaseIcon, tone: 'purple'},
  applications: {label: 'dataApps', icon: AppsIcon, tone: 'blue'},
  permissions: {label: 'dataPermissions', icon: ShieldIcon, tone: 'green'},
  events: {label: 'dataEvents', icon: HistoryIcon, tone: 'orange'},
} as const

export type Category = keyof typeof categories
export type Tone = typeof categories[Category]['tone']
export const categoryKeys = Object.keys(categories) as Category[]

export const metricCategories = {
  cpu: {label: 'dataCpu', icon: CpuIcon, category: 'performance', tone: 'orange'},
  memory: {label: 'dataMemory', icon: MeterIcon, category: 'performance', tone: 'purple'},
  disk: {label: 'dataDisk', icon: DatabaseIcon, category: 'storage', tone: 'blue'},
  battery: {label: 'dataBattery', icon: PlugIcon, category: 'power', tone: 'green'},
  'connection.quality': {label: 'dataLatency', icon: PulseIcon, category: 'network', tone: 'blue'},
} as const satisfies Record<string, {label: Message; icon: Icon; category: Category; tone: Tone}>

export function dataHref(category: Category = 'overview', inventory?: 'installed') {
  if (category === 'overview') return '#data'
  const parameters = new URLSearchParams({section: category})
  if (inventory) parameters.set('inventory', inventory)
  return '#data?' + parameters
}

export function categoryFromHash(hash: string): Category {
  const category = new URLSearchParams(hash.split('?')[1]).get('section')
  return category && Object.hasOwn(categories, category) ? category as Category : 'overview'
}
