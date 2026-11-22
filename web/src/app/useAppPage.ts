import {useEffect, useRef, useSyncExternalStore} from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

export type AppPage = 'files' | 'data'

export function useAppPage() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const files = useRef('#files')
  const page: AppPage = hash === '#data' || hash.startsWith('#data?') ? 'data' : 'files'

  useEffect(() => {
    if (page === 'files') files.current = hash || '#files'
  }, [hash, page])

  return {page, hash, filesHref: page === 'files' ? hash || '#files' : files.current,
    resetFileLocation: () => { files.current = '#files' }}
}
