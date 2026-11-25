import {useState} from 'react'
import {useAppearance} from '../app/AppTheme'
import {useLanguage, type Locale} from '../i18n'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {SettingsRow, SettingsRows} from './SettingsFields'
import {SettingsBand, SettingsNotice, SettingsPanel} from './SettingsPanel'

export function PreferencesSettings() {
  const {t, locale, setLocale} = useLanguage()
  const {contrast, setContrast} = useAppearance()
  const [language, setLanguage] = useState(locale)
  const [theme, setTheme] = useState(contrast)
  const [saved, setSaved] = useState(false)
  const dirty = language !== locale || theme !== contrast
  return <SettingsPanel title={t('settingsPreferences')} description={t('settingsPreferencesHelp')} disabled={!dirty} onApply={() => {
    setLocale(language)
    setContrast(theme)
    setSaved(true)
  }}>
    <SettingsBand>
      <SettingsRows>
        <SettingsRow title={t('language')}>
          <ChoiceMenu<Locale> label={t('language')} value={language} onChange={setLanguage}
            options={[{value: 'en', label: t('settingsEnglish')}, {value: 'zh-CN', label: t('settingsChinese')}]} />
        </SettingsRow>
        <SettingsRow title={t('appearance')}>
          <ChoiceMenu label={t('appearance')} value={theme} onChange={setTheme}
            options={[{value: 'standard', label: t('standardContrast')}, {value: 'high', label: t('highContrast')}]} />
        </SettingsRow>
      </SettingsRows>
      <SettingsNotice saved={saved && !dirty} />
    </SettingsBand>
  </SettingsPanel>
}
