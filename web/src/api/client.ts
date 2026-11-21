export const apiPrefix = '/api/v1'
export const sessionExpired = 'filesharing:session-expired'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs?: number) {
    super(code)
  }
}

type Query = Record<string, string | number | boolean | null | undefined>
type Options = RequestInit & {anonymous?: boolean}

export function query(route: string, parameters: Query) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  return search.size ? route + '?' + search : route
}

export async function response(route: string, {anonymous, ...options}: Options = {}) {
  const result = await fetch(apiPrefix + route, {...options, credentials: 'same-origin', cache: 'no-store'})
  if (result.ok) return result
  const problem: {code?: string} | null = await result.json().catch(() => null)
  if (result.status === 401 && !anonymous) window.dispatchEvent(new Event(sessionExpired))
  const retryAfter = result.headers.get('Retry-After')
  const delay = retryAfter === null ? NaN
    : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
    : Math.max(0, Date.parse(retryAfter) - Date.now())
  const fallback = result.status === 429 ? 'rate_limited' : 'request_failed'
  throw new ApiError(result.status, problem?.code ?? fallback, Number.isFinite(delay) ? delay : undefined)
}

export async function request<T>(route: string, options?: Options): Promise<T> {
  const result = await response(route, options)
  return (result.status === 204 ? undefined : await result.json()) as T
}

export function send<T>(route: string, method: string, body?: unknown, options: Options = {}) {
  const headers = new Headers(options.headers)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return request<T>(route, {...options, method, headers, body: JSON.stringify(body)})
}

export async function readAll<T>(route: string, signal?: AbortSignal) {
  const items: T[] = []
  let cursor: string | null = null
  do {
    const page: {items: T[]; nextCursor: string | null} =
      await request(query(route, {limit: 200, cursor}), {signal})
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

export function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort() {
      window.clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, {once: true})
  })
}
