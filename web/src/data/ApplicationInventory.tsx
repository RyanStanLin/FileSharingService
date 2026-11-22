import {useMemo, useState} from 'react'
import {Button, FormControl, Link, Select, Stack, TextInput} from '@primer/react'
import {AppsIcon, PackageIcon} from '@primer/octicons-react'
import {appIconUrl, type DataObject} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {DataCard} from './DataCard'
import {RecordDialog, RecordPager, useRecordPage} from './RecordList'
import {dataHref} from './categories'
import {decimal, records, textValue} from './format'
import type {TelemetryView} from './useTelemetry'
import styles from './details.module.css'

function appKey(item: DataObject) {
  return [item.applicationId, item.pid, item.installPath, item.name].join(':')
}

export function ApplicationInventory({telemetry, deviceId, installed}: {telemetry: TelemetryView; deviceId: string; installed: boolean}) {
  const {t, locale} = useLanguage()
  const topic = installed ? 'apps-installed' : 'apps-running'
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<DataObject>()
  const sample = telemetry.samples[topic]
  const items = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale)
    return records(sample?.value).filter(app =>
      [app.name, app.bundleId, app.pid, app.version, app.installPath].some(field =>
        String(field ?? '').toLocaleLowerCase(locale).includes(query)))
  }, [sample?.value, search, locale])
  const pager = useRecordPage(items)
  const active = selected && (items.find(item => appKey(item) === appKey(selected)) ?? selected)
  const applicationId = textValue(active?.applicationId)
  const iconUrl = applicationId && telemetry.connection.online && telemetry.connection.accessGranted
    ? appIconUrl(deviceId, applicationId) : undefined

  return <DataCard title={t('dataAppInventory')} tone="blue" icon={AppsIcon}
    observedAt={sample?.observedAt} stale={sample && (sample.stale || !telemetry.connection.online)}>
    <Stack gap="normal">
      <Stack direction="horizontal" align="end" wrap="wrap" gap="normal">
        <FormControl>
          <FormControl.Label>{t('dataInventoryType')}</FormControl.Label>
          <Select size="medium" value={topic} onChange={event => {
            window.location.hash = dataHref('applications', event.target.value === 'apps-installed' ? 'installed' : undefined)
            pager.setPage(1)
          }}>
            <Select.Option value="apps-running">{t('dataRunning')}</Select.Option>
            <Select.Option value="apps-installed">{t('dataInstalled')}</Select.Option>
          </Select>
        </FormControl>
        <Stack.Item grow>
          <FormControl>
            <FormControl.Label>{t('dataFilterApps')}</FormControl.Label>
            <TextInput type="search" size="medium" block value={search} onChange={event => {
              setSearch(event.target.value)
              pager.setPage(1)
            }} />
          </FormControl>
        </Stack.Item>
      </Stack>
      {sample && <span className={styles.muted}>{t(items.length === 1 ? 'dataResultOne' : 'dataResultCount',
        {count: decimal(items.length, locale)})}</span>}
      {pager.rows.length ? <ul className={styles.records}>
        {pager.rows.map(item => <li key={appKey(item)}>
          <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" wrap="wrap">
            <Stack className={styles.recordInfo} gap="none">
              <Button variant="invisible" size="medium" leadingVisual={PackageIcon} className={styles.recordButton}
                onClick={() => setSelected(item)}>{textValue(item.name) ?? t('missing')}</Button>
              {item.bundleId && <span className={styles.muted}>{textValue(item.bundleId)}</span>}
            </Stack>
            <span className={styles.recordMeta}>
              {[item.version, topic === 'apps-running' && t(item.foreground === true ? 'dataForeground' : 'dataBackground')]
                .filter(Boolean).join(' · ')}
            </span>
          </Stack>
        </li>)}
      </ul> : <p className={styles.muted}>{t(!sample ? 'dataNoSample' : search.trim() ? 'dataNoAppMatches' : 'dataNoApps')}</p>}
      <RecordPager {...pager} />
    </Stack>
    {active && <RecordDialog title={textValue(active.name) ?? t('dataApps')} value={active} close={() => setSelected(undefined)}>
      {iconUrl && <Link href={iconUrl} target="_blank" rel="noopener noreferrer">{t('dataIcon')}</Link>}
    </RecordDialog>}
  </DataCard>
}
