import type {TerminalAddress} from '../api/terminals'

export function terminalHref(id?: string, deviceId?: string, immersive = false) {
  if (!id) return '#terminal'
  const query = new URLSearchParams({session: id})
  if (deviceId) query.set('device', deviceId)
  if (immersive) query.set('view', 'immersive')
  return '#terminal?' + query
}

function identifier(value: string | null) {
  return value && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : undefined
}

export function terminalLocation(hash: string) {
  const [page, query] = hash.split('?', 2)
  const params = new URLSearchParams(page === '#terminal' ? query : '')
  return {id: identifier(params.get('session')), deviceId: identifier(params.get('device')), immersive: params.get('view') === 'immersive'}
}

export function openImmersive({id, deviceId}: TerminalAddress) {
  const url = new URL(terminalHref(id, deviceId, true), window.location.href)
  const popup = window.open('about:blank', '_blank', 'popup,width=1024,height=680,resizable=yes')
  if (!popup) {
    window.location.hash = url.hash
    return
  }
  popup.opener = null
  popup.location.replace(url.href)
}
