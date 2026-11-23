import {useState} from 'react'
import type {ReadingRow} from './readingModel'
import {laterSequence} from './useTelemetryStream'

interface Arrivals {
  source: ReadingRow[]
  visible: ReadingRow[]
  newest?: string
  active: ReadonlySet<string>
}

export function useEventArrivals(source: ReadingRow[], visible: ReadingRow[], ready: boolean | undefined, serverPaged: boolean) {
  const [arrivals, setArrivals] = useState<Arrivals>()

  if (ready && (arrivals?.source !== source || arrivals.visible !== visible)) {
    const active = new Set<string>()
    if (arrivals) {
      const seen = new Set(arrivals.source.map(row => row.id))
      for (const {id} of visible) {
        const isNew = !seen.has(id) && (!arrivals.newest || laterSequence(id, arrivals.newest))
        if (arrivals.active.has(id) || isNew) active.add(id)
      }
    }
    setArrivals({source, visible, newest: serverPaged ? source[0]?.id ?? arrivals?.newest : undefined, active})
  }

  function finish(id: string) {
    setArrivals(current => {
      if (!current?.active.has(id)) return current
      const active = new Set(current.active)
      active.delete(id)
      return {...current, active}
    })
  }

  return ready === undefined ? undefined : {ids: arrivals?.active, finish}
}
