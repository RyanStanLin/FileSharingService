import {useMemo, useState} from 'react'
import {Link, TextInput} from '@primer/react'
import {appIconUrl, type DataObject} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ApplicationIcon} from './ApplicationIcon'
import {ReadingPane, type ReadingChrome} from './ReadingPane'
import {dataHref} from './categories'
import {records, textValue} from './format'
import {cell, fieldColumns, valueCell, type ReadingRow} from './readingModel'
import type {TelemetryView} from './useTelemetry'

const installedFields = ['version', 'bundleId', 'build', 'installPath']
const runningFields = ['version', 'pid', 'state', 'launchedAt', 'uptimeSeconds', 'bundleId']

function appKey(item: DataObject) {
  return JSON.stringify([item.applicationId ?? item.installPath ?? item.name, item.pid, item.launchedAt])
}

function appName(item: DataObject) {
  const packageName = textValue(item.installPath)?.split('/').filter(Boolean).at(-1)?.replace(/\.app$/i, '')
  return textValue(item.name)?.trim() || packageName || textValue(item.bundleId)
}

export function ApplicationInventory({telemetry, deviceId, installed, chrome}: {
  telemetry: TelemetryView
  deviceId: string
  installed: boolean
  chrome: ReadingChrome
}) {
  const {t, locale} = useLanguage()
  const [search, setSearch] = useState('')
  const topic = installed ? 'apps-installed' : 'apps-running'
  const fields = installed ? installedFields : runningFields
  const sample = telemetry.samples[topic]
  const {online, accessGranted, connectionId} = telemetry.connection
  const iconConnection = online && accessGranted ? connectionId ?? undefined : undefined
  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale)
    return records(sample?.value).filter(app =>
      [appName(app), app.bundleId, app.pid, app.version, app.installPath].some(field =>
        String(field ?? '').toLocaleLowerCase(locale).includes(query))).map((app): ReadingRow => {
      const values = Object.fromEntries(fields.map(field => [field, valueCell(field, app[field], locale, t)]))
      if (!installed) {
        const state = app.hidden === true ? t('dataHiddenApp') : app.foreground === true ? t('dataForeground') : t('dataBackground')
        values.state = cell(state, state, true)
      }
      return {id: appKey(app), name: cell(appName(app) ?? t('missing')), values, value: app,
        icon: <ApplicationIcon device={deviceId} app={app} connectionId={iconConnection} />}
    })
  }, [deviceId, fields, iconConnection, installed, locale, sample?.value, search, t])

  return <ReadingPane chrome={chrome} filter={search} dataset={{
    key: topic, title: t('dataApps'), nameTitle: t('name'), columns: fieldColumns(fields, locale),
    rows, snapshot: sample, icons: true, details: true,
    empty: t(!sample ? 'dataNoSample' : search.trim() ? 'dataNoAppMatches' : 'dataNoApps'),
    pending: !sample && telemetry.stream === 'connecting',
  }} controls={<>
    <ChoiceMenu label={t('dataInventoryType')} value={topic}
      options={[{value: 'apps-running', label: t('dataRunning')}, {value: 'apps-installed', label: t('dataInstalled')}]}
      onChange={value => {
        window.location.hash = dataHref('applications', {inventory: value === 'apps-installed' ? 'installed' : undefined})
      }} />
    <TextInput type="search" size="medium" aria-label={t('dataFilterApps')} placeholder={t('dataFilterApps')}
      value={search} onChange={event => setSearch(event.target.value)} />
  </>} rowAction={row => {
    const id = textValue(row.value?.applicationId)
    return id && textValue(row.value?.installPath) && iconConnection ? <Link href={appIconUrl(deviceId, id)} target="_blank"
      rel="noopener noreferrer">{t('dataIcon')}</Link> : null
  }} />
}
