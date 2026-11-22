import type {DataObject, DataValue} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {fieldLabel} from './dataFields'
import {displayField, object} from './format'
import styles from './details.module.css'

function Value({name, value, parent}: {name: string; value: DataValue; parent?: string}) {
  const {t, locale} = useLanguage()
  const fields = object(value)
  if (fields) return <DataFacts value={fields} parent={name} />
  if (Array.isArray(value)) {
    if (!value.length) return <span className={styles.muted}>{t('dataEmptyList')}</span>
    if (value.every(item => item == null || typeof item !== 'object')) {
      return <>{new Intl.ListFormat(locale).format(value.map(item => displayField(name, item, locale, t, parent)))}</>
    }
    return <ul className={styles.nested}>
      {value.map((item, index) => <li key={index}><Value name={name} value={item} parent={parent} /></li>)}
    </ul>
  }
  return <>{displayField(name, value, locale, t, parent)}</>
}

export function DataFacts({value, parent}: {value?: DataObject; parent?: string}) {
  const {t, locale} = useLanguage()
  const fields = Object.entries(value ?? {})
  if (!fields.length) return <p className={styles.muted}>{t('dataNoSample')}</p>
  return <dl className={styles.facts}>
    {fields.map(([name, entry]) => <div key={name}>
      <dt>{fieldLabel(name, locale)}</dt>
      <dd><Value name={name} value={entry} parent={parent} /></dd>
    </div>)}
  </dl>
}
