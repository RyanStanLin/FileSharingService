import {BaseStyles, ThemeProvider} from '@primer/react'
import {createRoot} from 'react-dom/client'
import '@primer/primitives/dist/css/primitives.css'
import '@primer/primitives/dist/css/functional/themes/light.css'
import {App} from './app/App'
import {LanguageProvider} from './i18n'
import styles from './app/shell.module.css'

createRoot(document.getElementById('root')!).render(
  <ThemeProvider colorMode="day" dayScheme="light">
    <BaseStyles className={styles.base}>
      <LanguageProvider><App /></LanguageProvider>
    </BaseStyles>
  </ThemeProvider>,
)
