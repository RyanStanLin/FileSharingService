import {useEffect, useRef, useState, type RefObject} from 'react'
import type {DirectoryView} from './useDirectory'

export function useAutoPage(view: DirectoryView, scrollRoot?: RefObject<HTMLElement | null>) {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const load = useRef(view.next)
  const offset = view.page?.nextOffset
  const enabled = offset != null && !view.pending && !view.loadingMore && view.moreError == null

  useEffect(() => { load.current = view.next }, [view.next])
  useEffect(() => {
    if (!sentinel || !enabled) return
    const observer = new IntersectionObserver(records => {
      if (!records.some(record => record.isIntersecting)) return
      observer.disconnect()
      void load.current()
    }, {root: scrollRoot?.current ?? null})
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [enabled, offset, sentinel, scrollRoot])

  return setSentinel
}
