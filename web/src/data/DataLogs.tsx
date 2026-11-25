import {useCallback, useMemo} from 'react'
import {Button, Link, Stack} from '@primer/react'
import {readDeliveries, type DeliveryFilters} from '../api/notifications'
import {deliveryStates, type DeliveryState, type NotificationDelivery} from '../api/notificationTypes'
import {readAudit} from '../api/settings'
import type {Device, Page} from '../api/types'
import {useLanguage} from '../i18n'
import {deliveryLabel, deliveryUrl} from '../notifications/notificationLabels'
import {useNotificationUpdates} from '../notifications/useNotificationUpdates'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useRefresh} from '../ui/async'
import {useCursorArchive} from '../ui/useCursorArchive'
import {DeliveryDetails} from './DeliveryDetails'
import {ReadingPane, type ReadingChrome} from './ReadingPane'
import {dataHref, type LogCategory} from './categories'
import {auditDataset, deliveryDataset} from './logDatasets'
import styles from './dashboard.module.css'

interface Props {
  category: LogCategory
  devices: Device[]
  hash: string
  heading: string
}

export function DataLogs(props: Props) {
  const parameters = new URLSearchParams(props.hash.split('?')[1])
  return props.category === 'deliveries' ? <DeliveryLog {...props} parameters={parameters} /> :
    <AuditLog {...props} parameters={parameters} />
}

function LogNotice({error, retry}: {error: unknown; retry: () => void}) {
  const {t} = useLanguage()
  return error ? <Stack direction="horizontal" align="center" gap="condensed" padding="normal" className={styles.readingNotice}>
    <ErrorText error={error} /><Button size="medium" onClick={retry}>{t('retry')}</Button>
  </Stack> : null
}

function mergeDeliveries(previous: Page<NotificationDelivery> | undefined, head: Page<NotificationDelivery>) {
  const last = head.items.at(-1)
  if (!head.nextCursor || !last || !previous) return head
  if (!previous.items.some(item => item.sequence === last.sequence)) return head
  const older = previous.items.filter(item => BigInt(item.sequence) < BigInt(last.sequence))
  return older.length > 0 ? {items: [...head.items, ...older], nextCursor: previous.nextCursor} : head
}

function DeliveryLog({devices, heading, parameters}: Props & {parameters: URLSearchParams}) {
  const {t, locale} = useLanguage()
  const state = parameters.get('state')
  const filterState = deliveryStates.find(value => value === state)
  const channelId = parameters.get('channelId') || undefined
  const ruleId = parameters.get('ruleId') || undefined
  const deviceId = parameters.get('deviceId') || undefined
  const opened = parameters.get('delivery')
  const filters: DeliveryFilters = {channelId, ruleId, deviceId, state: filterState}
  const read = useCallback((_key: string, after: string | undefined, signal: AbortSignal) =>
    readDeliveries({channelId, ruleId, deviceId, state: filterState}, after, signal), [channelId, ruleId, deviceId, filterState])
  const archive = useCursorArchive('delivery', read, mergeDeliveries)
  const live = useNotificationUpdates(update => { if (!update || update.resource === 'delivery') archive.refresh() })
  useRefresh(true, archive.refresh, live ? 15_000 : 7000)
  const dataset = useMemo(() => deliveryDataset(archive.page?.items ?? [], locale, t), [archive.page, locale, t])
  const chrome: ReadingChrome = {heading, stream: t(live ? 'dataLive' : 'dataPolling'), offline: false,
    pending: archive.loading === 'recent' && !archive.page, action: <Button size="medium" onClick={archive.refresh}>{t('settingsRefresh')}</Button>,
    notices: <LogNotice error={archive.error} retry={archive.refresh} />}
  const stateOptions: {value: DeliveryState | ''; label: string}[] = [{value: '', label: t('notificationAnyStatus')}, ...deliveryStates.map(value => ({value, label: t(deliveryLabel[value])}))]
  const close = () => { window.location.hash = deliveryUrl(filters) }
  return <>
    <ReadingPane chrome={chrome} dataset={dataset} eventHistoryReady={!!archive.page}
      controls={<>
        <LogDeviceFilter devices={devices} value={deviceId} change={selected => { window.location.hash = deliveryUrl({...filters, deviceId: selected}) }} />
        <ChoiceMenu<DeliveryState | ''> label={t('notificationDeliveryStatus')} options={stateOptions}
          value={filterState ?? ''} onChange={selected => { window.location.hash = deliveryUrl({...filters, state: selected || undefined}) }} />
        {(ruleId || channelId) && <Link href={deliveryUrl()}>{t('notificationClearFilter')}</Link>}
      </>}
      rowDetails={row => <DeliveryDetails id={String(row.value?.id)} />}
      pagination={{cursor: archive.page?.nextCursor ?? undefined, loading: archive.loading === 'older', error: archive.moreError, next: archive.next}} />
    {opened && <Modal title={t('notificationDeliveries')} onClose={close}
      footerButtons={[{content: t('close'), size: 'medium', onClick: close}]}>
      <DeliveryDetails id={opened} />
    </Modal>}
  </>
}

function AuditLog({devices, heading, parameters}: Props & {parameters: URLSearchParams}) {
  const {t} = useLanguage()
  const deviceId = parameters.get('deviceId') || undefined
  const read = useCallback((_key: string, cursor: string | undefined, signal: AbortSignal) =>
    readAudit(cursor, deviceId, signal), [deviceId])
  const archive = useCursorArchive('audit', read)
  useRefresh(true, archive.refresh, 7000)
  const names = useMemo(() => new Map(devices.map(device => [device.id, device.name])), [devices])
  const dataset = useMemo(() => auditDataset(archive.page?.items ?? [], names, t), [archive.page, names, t])
  const chrome: ReadingChrome = {heading, stream: t('dataPolling'), offline: false,
    pending: archive.loading === 'recent' && !archive.page, action: <Button size="medium" onClick={archive.refresh}>{t('settingsRefresh')}</Button>,
    notices: <LogNotice error={archive.error} retry={archive.refresh} />}
  return <ReadingPane chrome={chrome} dataset={dataset} eventHistoryReady={!!archive.page}
    controls={<LogDeviceFilter devices={devices} value={deviceId} change={selected => {
      window.location.hash = selected ? '#data?' + new URLSearchParams({section: 'audit', deviceId: selected}) : dataHref('audit')
    }} />}
    pagination={{cursor: archive.page?.nextCursor ?? undefined, loading: archive.loading === 'older', error: archive.moreError, next: archive.next}} />
}

function LogDeviceFilter({devices, value, change}: {devices: Device[]; value?: string; change: (id?: string) => void}) {
  const {t} = useLanguage()
  const options = [{value: '', label: t('notificationAllDevices')}, ...devices.map(device => ({value: device.id, label: device.name}))]
  if (value && !options.some(option => option.value === value)) options.push({value, label: value})
  return <ChoiceMenu label={t('settingsDevice')} value={value ?? ''} options={options} onChange={id => change(id || undefined)} />
}
