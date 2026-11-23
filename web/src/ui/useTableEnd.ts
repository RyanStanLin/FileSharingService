import {useEffect, useRef, useState, type RefObject} from 'react'

export function useTableEnd(cursor: string | number | undefined, advance: () => void, scrollRoot?: RefObject<HTMLElement | null>) {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null)
  const load = useRef(advance)
  useEffect(() => { load.current = advance }, [advance])
  useEffect(() => {
    if (!sentinel || cursor === undefined) return
    const observer = new IntersectionObserver(records => {
      if (!records.some(record => record.isIntersecting)) return
      observer.disconnect()
      load.current()
    }, {root: scrollRoot?.current ?? null})
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, sentinel, scrollRoot])
  return setSentinel
}
