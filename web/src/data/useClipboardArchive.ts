import {useEffect, useRef} from 'react'
import {readClipboardRecords} from '../api/clipboard'
import {useRefresh} from '../ui/async'
import {useCursorArchive} from '../ui/useCursorArchive'

export function useClipboardArchive(deviceId: string | null, streaming: boolean, newestEvent: string | undefined) {
  const archive = useCursorArchive(deviceId, readClipboardRecords)
  const {refresh} = archive
  const eventTimer = useRef<number | undefined>(undefined)
  const lastEvent = useRef(newestEvent)
  const wasStreaming = useRef(streaming)

  useEffect(() => () => {
    window.clearTimeout(eventTimer.current)
    eventTimer.current = undefined
  }, [deviceId])
  useRefresh(deviceId !== null && !streaming, refresh, 15_000)
  useEffect(() => {
    if (streaming && !wasStreaming.current) refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])
  useEffect(() => {
    if (newestEvent === lastEvent.current) return
    lastEvent.current = newestEvent
    if (!deviceId || !newestEvent || eventTimer.current !== undefined) return
    eventTimer.current = window.setTimeout(() => {
      eventTimer.current = undefined
      refresh()
    }, 700)
  }, [deviceId, newestEvent, refresh])

  return archive
}
