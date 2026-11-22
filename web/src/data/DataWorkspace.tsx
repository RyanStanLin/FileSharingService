import {useEffect, useId, useRef, useState} from 'react'
import {Button, Heading, Label, SplitPageLayout, Stack, useResponsiveValue} from '@primer/react'
import {ListUnorderedIcon, SyncIcon} from '@primer/octicons-react'
import {requestSample} from '../api/telemetry'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTask} from '../ui/async'
import {ThumbnailProvider} from '../ui/thumbnails'
import {ActivityList} from './ActivityList'
import {ApplicationInventory} from './ApplicationInventory'
import {DataOverview} from './DataOverview'
import {DataSidebar} from './DataSidebar'
import type {ReadingChrome} from './ReadingPane'
import {TelemetryReading} from './TelemetryReading'
import {categoryFromHash} from './categories'
import {useTelemetry} from './useTelemetry'
import {useTelemetryHistory} from './useTelemetryHistory'
import styles from './dashboard.module.css'

const sidebarWidth = {min: '176px', default: '272px', max: '480px'} as const
const streamLabels = {connecting: 'dataConnecting', live: 'dataLive', polling: 'dataPolling', offline: 'dataOffline'} as const

interface Props {
  device: Device
  hash: string
  refreshDevice: () => void
  authorize: () => void
  authorizationBusy: boolean
  authorizationError: unknown
}

export default function DataWorkspace({device, hash, refreshDevice, authorize, authorizationBusy, authorizationError}: Props) {
  const {t} = useLanguage()
  const category = categoryFromHash(hash)
  const parameters = new URLSearchParams(hash.split('?')[1])
  const heading = useId()
  const sidebarId = useId()
  const menu = useRef<HTMLButtonElement>(null)
  const [showNavigation, setShowNavigation] = useState(false)
  const [sampleReady, setSampleReady] = useState(false)
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)
  const telemetry = useTelemetry(device, refreshDevice)
  const {connection, pending, error} = telemetry
  const stream = connection.online ? telemetry.stream : 'offline'
  const streamText = t(streamLabels[stream])
  const {history, trends, activity} = useTelemetryHistory(device.id, telemetry.history, stream === 'live', category === 'events')
  const task = useTask()

  useEffect(() => { if (!narrow) setShowNavigation(false) }, [narrow])
  useEffect(() => { setSampleReady(false) }, [category])

  function refresh() {
    telemetry.refresh()
    refreshDevice()
    trends.refresh()
    if (category === 'events') activity.refresh()
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
  const historyError = category === 'events' ? activity.data?.error ?? activity.error : hasTrends && (trends.data?.error ?? trends.error)
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
    content = <ActivityList history={history} pending={activity.pending && !activity.data} chrome={chrome} />
  } else {
    content = <TelemetryReading key={category} category={category} view={parameters.get('view')}
      device={device} telemetry={telemetry} history={history} chrome={chrome} />
  }

  return <ThumbnailProvider>
    <SplitPageLayout className={styles.workspace}>
      {!narrow && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarWidth}
        resizable widthStorageKey="filesharing.data-sidebar-width" aria-label={t('dataCategories')}>
        <div className={styles.sidebar}><DataSidebar selected={category} /></div>
      </SplitPageLayout.Sidebar>}
      <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
        <Stack as="main" aria-labelledby={heading} className={styles.pane} gap="none">
          {narrow && <div className={styles.mobileNavigation}>
            <Button ref={menu} size="medium" leadingVisual={ListUnorderedIcon} aria-haspopup="dialog" aria-expanded={showNavigation}
              aria-controls={sidebarId} onClick={() => setShowNavigation(true)}>{t('dataCategories')}</Button>
          </div>}
          {content}
        </Stack>
      </SplitPageLayout.Content>
    </SplitPageLayout>
    {narrow && showNavigation && <Modal title={t('dataCategories')} onClose={() => setShowNavigation(false)} returnFocusRef={menu}>
      <div id={sidebarId}><DataSidebar selected={category} close={() => setShowNavigation(false)} /></div>
    </Modal>}
  </ThumbnailProvider>
}
