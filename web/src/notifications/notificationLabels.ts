import type {DeliveryFilters} from '../api/notifications'
import type {DeliveryState, NotificationWatch} from '../api/notificationTypes'
import type {Locale, Message} from '../i18n'

export const deliveryLabel = {
  queued: 'notificationDeliveryQueued', sending: 'notificationDeliverySending', retryScheduled: 'notificationDeliveryRetry',
  sent: 'notificationDeliverySent', failed: 'notificationDeliveryFailed', cancelled: 'notificationDeliveryCancelled',
} as const satisfies Record<DeliveryState, Message>

export const watchLabel = {
  checking: 'notificationWatchChecking', starting: 'notificationWatchStarting', active: 'notificationWatchActive',
  waitingForConnection: 'notificationWatchOffline', awaitingAuthorization: 'notificationWatchAuthorize',
  unavailable: 'notificationWatchUnavailable',
} as const satisfies Record<NotificationWatch['state'], Message>

export function deliveryUrl(filters: DeliveryFilters & {delivery?: string} = {}) {
  const params = new URLSearchParams({section: 'deliveries'})
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  return '#data?' + params
}

const groups = {
  device: ['Connection', '设备连接'], lid: ['Lid', '上盖'],
  system: ['System', '系统'], display: ['Displays', '显示器'],
  application: ['Applications', '应用程序'], storage: ['Storage', '存储'],
  network: ['Network', '网络'], power: ['Power', '电源'],
  battery: ['Battery', '电池'], cpu: ['CPU', 'CPU'],
  memory: ['Memory', '内存'], clipboard: ['Clipboard', '剪贴板'],
  telemetry: ['Telemetry', '遥测'], file: ['Files', '文件'],
} as const

const events: Record<string, readonly [string, string]> = {
  'device.online': ['Device online', '设备上线'],
  'device.offline': ['Device offline', '设备离线'],
  'lid.closed': ['Lid closed', '合盖'],
  'lid.opened': ['Lid opened', '开盖'],
  'system.sleeping': ['System sleeping', '系统进入睡眠'],
  'system.woke': ['System woke', '系统唤醒'],
  'system.locked': ['Session locked', '会话锁定'],
  'system.unlocked': ['Session unlocked', '会话解锁'],
  'display.slept': ['Display slept', '显示器休眠'],
  'display.woke': ['Display woke', '显示器唤醒'],
  'display.configurationChanged': ['Display configuration changed', '显示配置变化'],
  'application.launched': ['Application launched', '应用启动'],
  'application.terminated': ['Application quit', '应用退出'],
  'application.activated': ['Application activated', '应用切到前台'],
  'application.deactivated': ['Application deactivated', '应用离开前台'],
  'application.hidden': ['Application hidden', '应用隐藏'],
  'application.unhidden': ['Application unhidden', '应用取消隐藏'],
  'application.installed': ['Application installed', '应用安装'],
  'application.removed': ['Application removed', '应用移除'],
  'application.updated': ['Application updated', '应用更新'],
  'storage.inserted': ['Storage connected', '存储设备插入'],
  'storage.removed': ['Storage disconnected', '存储设备拔出'],
  'storage.mounted': ['Volume mounted', '宗卷挂载'],
  'storage.unmounted': ['Volume unmounted', '宗卷卸载'],
  'network.changed': ['Network changed', '网络变化'],
  'network.reachable': ['Network reachable', '网络恢复'],
  'network.unavailable': ['Network unavailable', '网络不可达'],
  'power.lowPowerEnabled': ['Low Power Mode enabled', '启用低电量模式'],
  'power.lowPowerDisabled': ['Low Power Mode disabled', '关闭低电量模式'],
  'battery.externalConnected': ['External power connected', '连接外接电源'],
  'battery.externalDisconnected': ['External power disconnected', '断开外接电源'],
  'battery.chargingStarted': ['Charging started', '开始充电'],
  'battery.chargingStopped': ['Charging stopped', '停止充电'],
  'battery.levelBelow': ['Battery below threshold', '电量低于阈值'],
  'battery.levelRecovered': ['Battery recovered', '电量恢复至阈值'],
  'cpu.usageAbove': ['CPU reached threshold', 'CPU 使用率达到阈值'],
  'cpu.usageBelow': ['CPU below threshold', 'CPU 使用率低于阈值'],
  'memory.usageAbove': ['Memory reached threshold', '内存使用率达到阈值'],
  'memory.usageBelow': ['Memory below threshold', '内存使用率低于阈值'],
  'clipboard.changed': ['Clipboard changed', '剪贴板变化'],
  'telemetry.gap': ['Buffered telemetry lost', '积压的遥测数据丢失'],
  'file.added': ['Entry added', '条目新增'],
  'file.removed': ['Entry removed', '条目移除'],
  'file.renamed': ['Entry renamed', '条目重命名'],
  'file.modified': ['Entry modified', '条目修改'],
  'file.directoryChanged': ['Directory changed', '目录变化'],
  'test': ['Test notification', '测试通知'],
}

export const eventName = (type: string, locale: Locale) => events[type]?.[locale === 'en' ? 0 : 1] ?? type
export const eventGroup = (type: string) => type.split('.', 1)[0]
export const eventGroupName = (group: string, locale: Locale) =>
  groups[group as keyof typeof groups]?.[locale === 'en' ? 0 : 1] ?? group
