import {BaseStyles, ThemeProvider} from '@primer/react'
import {createContext, useContext, useState, type ReactNode} from 'react'
import styles from './shell.module.css'

type Contrast = 'standard' | 'high'
const preference = 'filesharing.contrast'
const Appearance = createContext<{contrast: Contrast; setContrast: (value: Contrast) => void} | null>(null)

export function AppTheme({children}: {children: ReactNode}) {
  const [contrast, updateContrast] = useState<Contrast>(() => localStorage.getItem(preference) === 'high' ? 'high' : 'standard')

  function setContrast(value: Contrast) {
    updateContrast(value)
    localStorage.setItem(preference, value)
  }

  return (
    <ThemeProvider colorMode="auto" dayScheme={contrast === 'high' ? 'light_high_contrast' : 'light'}
      nightScheme={contrast === 'high' ? 'dark_high_contrast' : 'dark'}>
      <BaseStyles className={styles.base}>
        <Appearance.Provider value={{contrast, setContrast}}>{children}</Appearance.Provider>
      </BaseStyles>
    </ThemeProvider>
  )
}

export function useAppearance() {
  const appearance = useContext(Appearance)
  if (!appearance) throw new Error('AppTheme is missing')
  return appearance
}
