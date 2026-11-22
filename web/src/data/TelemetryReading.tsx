import {Button, Select, Stack} from '@primer/react'
import {readAll} from '../api/client'
import {deviceRoute} from '../api/devices'
import type {DataObject, History} from '../api/telemetry'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {ReadingPane, type ReadingChrome} from './ReadingPane'
import {dataHref, type Category} from './categories'
import {networkDatasets, permissionDatasets, storageDatasets} from './inventoryDatasets'
import {deviceDatasets, performanceDatasets, powerDatasets} from './telemetryDatasets'
import type {TelemetryView} from './useTelemetry'
import styles from './dashboard.module.css'

type TelemetryCategory = Exclude<Category, 'overview' | 'applications' | 'events'>

export function TelemetryReading({category, view, device, telemetry, history, chrome}: {
  category: TelemetryCategory
  view: string | null
  device: Device
  telemetry: TelemetryView
  history: History
  chrome: ReadingChrome
}) {
  const {t, locale} = useLanguage()
  const grants = useResource(category === 'permissions' ? device.id : null,
    signal => readAll<DataObject>(deviceRoute(device.id) + '/file-roots', signal))
  useRefresh(category === 'permissions' && !grants.pending, grants.refresh, 20_000)
  const context = {device, telemetry, history, locale, t}
  const datasets = ({
    device: deviceDatasets,
    performance: performanceDatasets,
    power: powerDatasets,
    network: networkDatasets,
    storage: storageDatasets,
    permissions: () => permissionDatasets(context, grants.data, grants.pending),
  }[category])(context)
  const dataset = datasets.find(item => item.key === view) ?? datasets[0]
  const error = dataset.key === 'grants' ? grants.error : dataset.key === 'policy' ? telemetry.policy.error : undefined
  const local = error ? {
    ...chrome, notices: <>{chrome.notices}
      <Stack direction="horizontal" align="center" padding="normal" gap="condensed" className={styles.readingNotice}>
        <ErrorText error={error} />
        <Button size="medium" onClick={dataset.key === 'grants' ? grants.refresh : telemetry.policy.refresh}>{t('retry')}</Button>
      </Stack>
    </>,
  } : chrome
  return <ReadingPane chrome={local} dataset={dataset} controls={
    <Select size="medium" aria-label={t('dataView')} value={dataset.key}
      onChange={event => { window.location.hash = dataHref(category, {view: event.target.value}) }}>
      {datasets.map(item => <Select.Option key={item.key} value={item.key}>{item.title}</Select.Option>)}
    </Select>
  } />
}
