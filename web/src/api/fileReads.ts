import {ApiError, wait} from './client'

export type FileReadPriority = 'interactive' | 'background' | 'thumbnail'

interface QueuedRead {
  priority: FileReadPriority
  run: () => Promise<void>
}

interface DeviceReads {
  active: boolean
  wake: number | undefined
  resumeAt: number
  pending: QueuedRead[]
}

const lanes = new Map<string, DeviceReads>()
const busyDelay = 650

function drain(device: string, lane: DeviceReads) {
  if (lane.active || lane.wake !== undefined) return
  const delay = Math.max(0, lane.resumeAt - performance.now())
  if (delay > 0) {
    lane.wake = window.setTimeout(() => {
      lane.wake = undefined
      drain(device, lane)
    }, delay)
    return
  }
  const interactive = lane.pending.findIndex(item => item.priority === 'interactive')
  const preferred = interactive < 0 ? lane.pending.findIndex(item => item.priority === 'background') : interactive
  const [next] = lane.pending.splice(Math.max(0, preferred), 1)
  if (!next) {
    lanes.delete(device)
    return
  }
  lane.active = true
  void next.run().finally(() => {
    lane.active = false
    drain(device, lane)
  })
}

function enqueue<T>(device: string, priority: FileReadPriority, signal: AbortSignal, work: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted()
    let lane = lanes.get(device)
    if (!lane) {
      lane = {active: false, wake: undefined, resumeAt: 0, pending: []}
      lanes.set(device, lane)
    }
    const deviceLane = lane
    const queued: QueuedRead = {
      priority,
      run: async () => {
        signal.removeEventListener('abort', cancel)
        try {
          signal.throwIfAborted()
          resolve(await work())
        } catch (error) {
          if (error instanceof ApiError && error.status === 429) {
            deviceLane.resumeAt = performance.now() + Math.max(busyDelay, error.retryAfterMs ?? 0)
          } else if (signal.aborted) {
            deviceLane.resumeAt = performance.now() + 150
          }
          reject(error)
        }
      },
    }
    function cancel() {
      const index = deviceLane.pending.indexOf(queued)
      if (index !== -1) deviceLane.pending.splice(index, 1)
      reject(signal.reason)
    }
    lane.pending.push(queued)
    signal.addEventListener('abort', cancel, {once: true})
    if (!lane.active && lane.wake === undefined) {
      lane.wake = window.setTimeout(() => {
        deviceLane.wake = undefined
        drain(device, deviceLane)
      }, 0)
    }
  })
}

function retryDelay(error: unknown, attempt: number, retrySnapshot: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 429 && attempt < 2 && (error.retryAfterMs ?? 0) <= 4000) {
      return Math.max(error.retryAfterMs ?? 0, busyDelay * 2 ** attempt)
    }
    if (retrySnapshot && error.code === 'snapshot_changed' && attempt < 2) return 250 * (attempt + 1)
    if ((error.code === 'device_timeout' || error.status === 502 || error.status === 504) && attempt === 0) return busyDelay
  }
  if (error instanceof TypeError && attempt === 0) return busyDelay
}

export async function readFile<T>(device: string, priority: FileReadPriority, signal: AbortSignal,
  work: () => Promise<T>, retrySnapshot = false) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await enqueue(device, priority, signal, work)
    } catch (error) {
      signal.throwIfAborted()
      const delay = retryDelay(error, attempt, retrySnapshot)
      if (delay === undefined) throw error
      await wait(delay, signal)
    }
  }
}
