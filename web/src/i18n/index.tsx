import {createContext, useContext, useEffect, useMemo, useState, type ReactNode} from 'react'
import {ApiError} from '../api/client'
import {en, errorsEn} from './en'
import {errorsZh, zh} from './zh'

export type Message = keyof typeof en
export type Locale = 'en' | 'zh-CN'
export type Translate = (key: Message, values?: Record<string, string | number>) => string

interface Language {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translate
  errorText: (error: unknown) => string
}

const preference = 'filesharing.locale'
const LanguageContext = createContext<Language | null>(null)

function initialLocale(): Locale {
  const saved = localStorage.getItem(preference)
  if (saved === 'en' || saved === 'zh-CN') return saved
  return navigator.language.startsWith('zh') ? 'zh-CN' : 'en'
}

function errorCode(error: unknown) {
  if (error instanceof ApiError) return error.code
  if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) return 'passkey_cancelled'
  if (error instanceof TypeError) return 'network'
  return 'request_failed'
}

export function LanguageProvider({children}: {children: ReactNode}) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  useEffect(() => {
    document.documentElement.lang = locale
    localStorage.setItem(preference, locale)
  }, [locale])

  const value = useMemo<Language>(() => {
    const messages = locale === 'en' ? en : zh
    const errors = locale === 'en' ? errorsEn : errorsZh
    return {
      locale, setLocale,
      t: (key, values) => messages[key].replace(/\{(\w+)\}/g, (match, parameter: string) =>
        Object.hasOwn(values ?? {}, parameter) ? String(values?.[parameter]) : match),
      errorText: error => errors[errorCode(error)] ?? errors.request_failed,
    }
  }, [locale])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const value = useContext(LanguageContext)
  if (!value) throw new Error('LanguageProvider is missing')
  return value
}
