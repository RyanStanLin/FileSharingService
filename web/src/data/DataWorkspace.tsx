import {useEffect, useId, useState, type ReactNode} from 'react'
import {Button, Heading, Label, Stack} from '@primer/react'
import {SyncIcon} from '@primer/octicons-react'
import {requestSample} from '../api/telemetry'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {useTask} from '../ui/async'
import {ThumbnailProvider} from '../ui/thumbnails'
import {ActivityList} from './ActivityList'
import {ApplicationInventory} from './ApplicationInventory'
import {DataOverview} from './DataOverview'
import {DataFrame} from './DataFrame'
import {DataLogs} from './DataLogs'
import type {ReadingChrome} from './ReadingPane'
import {TelemetryReading} from './TelemetryReading'
import {categoryFromHash} from './categories'
import {eventViewFromQuery} from './eventViews'
import {useTelemetry} from './useTelemetry'
import {useTelemetryHistory} from './useTelemetryHistory'
import styles from './dashboard.module.css'

const streamLabels = {connecting: 'dataConnecting', live: 'dataLive', polling: 'dataPolling', offline: 'dataOffline'} as const

interface DeviceProps {
  device: Device
  hash: string
  refreshDevice: () => void
  authorize: () => void
  authorizationBusy: boolean
  authorizationError: unknown
}

export default function DataWorkspace(props: Omit<DeviceProps, 'device'> & {
  device?: Device; devices: Device[]; unavailable: ReactNode
}) {
  const heading = useId()
  const category = categoryFromHash(props.hash)
  if (category === 'deliveries' || category === 'audit') return <DataFrame category={category} eventView="all" heading={heading}>
    <DataLogs key={props.hash} category={category} hash={props.hash} devices={props.devices} heading={heading} />
  </DataFrame>
  return props.device ? <DeviceDataWorkspace key={props.device.id} {...props} device={props.device} /> :
    <DataFrame category={category} eventView="all">{props.unavailable}</DataFrame>
}

function DeviceDataWorkspace({device, hash, refreshDevice, authorize, authorizationBusy, authorizationError}: DeviceProps) {
  const {t} = useLanguage()
  const category = categoryFromHash(hash)
  const parameters = new URLSearchParams(hash.split('?')[1])
  const view = parameters.get('view')
  const eventView = eventViewFromQuery(view)
  const heading = useId()
  const [sampleReady, setSampleReady] = useState(false)
  const telemetry = useTelemetry(device, refreshDevice)
  const {connection, pending, error} = telemetry
  const stream = connection.online ? telemetry.stream : 'offline'
  const streamText = t(streamLabels[stream])
  const showActivity = category === 'events' && eventView !== 'clipboard.changed'
  const {history, trends, activity} = useTelemetryHistory(device.id, telemetry.history, stream === 'live', showActivity)
  const task = useTask()

  useEffect(() => { setSampleReady(false) }, [category])

  function refresh() {
    telemetry.refresh()
    refreshDevice()
    trends.refresh()
    if (showActivity) activity.refresh()
  }

  function sample() {
    setSampleReady(false)
    void task.run(async signal => {
      await requestSample(device.id, signal)
      if (signal.aborted) return
      refresh()
      setSampleReady(true)
    })
  }

  const hasTrends = ['overview', 'performance', 'power', 'network', 'storage'].includes(category)
  const historyError = showActivity ? activity.data?.error ?? activity.error : hasTrends && (trends.data?.error ?? trends.error)
  const operationError = task.error ?? authorizationError
  const action = connection.online && connection.accessGranted
    ? <Button size="medium" leadingVisual={SyncIcon} loading={task.busy} onClick={sample}>{t('dataSample')}</Button>
    : connection.online
      ? <Button size="medium" loading={authorizationBusy} onClick={authorize}>{t('allowConnection')}</Button>
      : <Button size="medium" leadingVisual={SyncIcon} onClick={refresh}>{t('dataRefresh')}</Button>
  const notices = (operationError || sampleReady || error || historyError) ? <Stack padding="normal" gap="condensed" className={styles.readingNotice}>
    <ErrorText error={operationError} />
    {sampleReady && <span role="status" className={styles.feedback}>{t('dataSampleReady')}</span>}
    {Boolean(error || historyError) && <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
      {error ? <ErrorText error={error} /> : <span role="alert">{t('dataHistoryError')}</span>}
      <Button size="medium" onClick={refresh}>{t('retry')}</Button>
    </Stack>}
  </Stack> : null
  const chrome: ReadingChrome = {heading, deviceName: device.name, stream: streamText, offline: !connection.online, pending, action, notices}

  let content
  if (category === 'overview') {
    content = <Stack gap="none" className={styles.scroll}>
      <Stack padding={{narrow: 'normal', regular: 'spacious'}} gap="normal" className={styles.page}>
        <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap" gap="condensed">
          <Heading as="h1" id={heading} className={styles.sectionTitle}>{t('dataCurrent')}</Heading>
          <Stack direction="horizontal" align="center" gap="condensed" wrap="wrap">
            <span role="status"><Label variant={stream === 'live' ? 'success' : 'secondary'}>{streamText}</Label></span>
            {action}
          </Stack>
        </Stack>
        {notices}
        {pending ? <Loading /> : <DataOverview device={device} telemetry={telemetry} history={history} />}
      </Stack>
    </Stack>
  } else if (category === 'applications') {
    content = <ApplicationInventory deviceId={device.id} telemetry={telemetry} installed={parameters.get('inventory') === 'installed'} chrome={chrome} />
  } else if (category === 'events') {
    content = <ActivityList deviceId={device.id} eventView={eventView} streaming={stream === 'live'}
      newestClipboard={telemetry.history['clipboard.changed']?.at(-1)?.sequence} history={history}
      historyReady={activity.data !== undefined} pending={activity.pending && !activity.data} chrome={chrome} />
  } else if (category !== 'audit' && category !== 'deliveries') {
    content = <TelemetryReading key={category} category={category} view={view}
      device={device} telemetry={telemetry} history={history} chrome={chrome} />
  }

  return <ThumbnailProvider>
    <DataFrame category={category} eventView={eventView} heading={heading}>{content}</DataFrame>
  </ThumbnailProvider>
}
