import {query, request} from './client'
import {deviceRoute} from './devices'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowDisplay {
  id: number
  main: boolean
  bounds: WindowBounds
}

export interface ObservedWindow {
  id: number
  pid: number
  ownerName: string | null
  layer: number
  alpha: number
  bounds: WindowBounds
  displayId: number | null
  relativeBounds: WindowBounds | null
  onScreen: boolean
  zIndex: number | null
  focused: boolean
  occlusion: {state: string}
}

export interface WindowSnapshot {
  revision: string
  observedAt: string
  value: {
    available: boolean
    activePid: number | null
    focusedWindowId: number | null
    displays: WindowDisplay[]
    windows: ObservedWindow[]
    truncated: boolean
  }
}

export function readWindows(deviceId: string, after: string | undefined, signal: AbortSignal) {
  const route = query(deviceRoute(deviceId) + '/windows', {after, waitSeconds: after ? 10 : undefined})
  return request<WindowSnapshot | undefined>(route, {signal})
}
