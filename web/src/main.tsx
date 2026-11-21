import {createRoot} from 'react-dom/client'
import '@primer/primitives/dist/css/primitives.css'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '@primer/primitives/dist/css/functional/themes/light-high-contrast.css'
import '@primer/primitives/dist/css/functional/themes/dark-high-contrast.css'
import {App} from './app/App'
import {AppTheme} from './app/AppTheme'
import {LanguageProvider} from './i18n'

createRoot(document.getElementById('root')!).render(
  <AppTheme><LanguageProvider><App /></LanguageProvider></AppTheme>,
)
