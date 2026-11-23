import type {DataObject, Snapshot} from '../api/telemetry'
import type {ObservedWindow, WindowBounds, WindowDisplay} from '../api/windows'
import {numeric, object, records} from '../data/format'

export function displayResolution(display: WindowDisplay, sample?: Snapshot) {
  const detail = records(object(sample?.value)?.items).find(item => item.id === display.id)
  const width = numeric(detail?.width)
  const height = numeric(detail?.height)
  return width && height && width > 0 && height > 0 ? {width, height} : undefined
}

export function byProcess(sample?: Snapshot) {
  const apps = new Map<number, DataObject>()
  for (const app of records(sample?.value)) {
    const pid = numeric(app.pid)
    if (pid !== undefined) apps.set(pid, app)
  }
  return apps
}

export function processUptime(app: DataObject | undefined, now: number, observedAt?: string | null) {
  const seconds = numeric(app?.uptimeSeconds)
  const sampled = Date.parse(observedAt ?? '')
  if (seconds !== undefined && Number.isFinite(sampled)) return seconds + Math.max(0, now - sampled) / 1000
  const launched = typeof app?.launchedAt === 'string' ? Date.parse(app.launchedAt) : NaN
  return Number.isFinite(launched) ? Math.max(0, now - launched) / 1000 : seconds
}

function relative(window: ObservedWindow, display: WindowDisplay): WindowBounds {
  if (window.displayId === display.id && window.relativeBounds) return window.relativeBounds
  return {...window.bounds, x: window.bounds.x - display.bounds.x, y: window.bounds.y - display.bounds.y}
}

export function projectWindows(windows: ObservedWindow[], display: WindowDisplay) {
  const {width, height} = display.bounds
  const visible = windows.flatMap(window => {
    if (!window.onScreen || window.zIndex === null || window.alpha <= 0 || window.layer < 0) return []
    const bounds = relative(window, display)
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.x >= width || bounds.y >= height ||
        bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0) return []
    return [{window, depth: -window.zIndex, left: bounds.x / width, top: bounds.y / height,
      width: bounds.width / width, height: bounds.height / height}]
  })
  return visible.sort((first, second) => first.window.id - second.window.id)
}
