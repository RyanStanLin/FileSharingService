import {useEffect, useRef, useSyncExternalStore} from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export type AppPage = 'files' | 'data' | 'activity' | 'alerts'

export function useAppPage() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const files = useRef('#files')
  const section = hash.slice(1).split('?', 1)[0]
  const page: AppPage = section === 'data' || section === 'activity' || section === 'alerts' ? section : 'files'

  useEffect(() => {
    if (page === 'files') files.current = hash || '#files'
  }, [hash, page])

  return {page, hash, filesHref: page === 'files' ? hash || '#files' : files.current,
    resetFileLocation: () => { files.current = '#files' }}
}
