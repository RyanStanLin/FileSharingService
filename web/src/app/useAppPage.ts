import {useEffect, useRef, useSyncExternalStore} from 'react'

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}

const pages = ['files', 'data', 'activity', 'alerts', 'terminal', 'settings', 'subscriptions'] as const
export type AppPage = typeof pages[number]

export function useAppPage() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const files = useRef('#files')
  const section = hash.slice(1).split('?', 1)[0]
  const page = pages.find(item => item === section) ?? 'files'

  useEffect(() => {
    if (page === 'files') files.current = hash || '#files'
  }, [hash, page])

  return {page, hash, filesHref: page === 'files' ? hash || '#files' : files.current,
    resetFileLocation: () => { files.current = '#files' }}
}
