import {useEffect, useId, useRef, useState} from 'react'
import {Button, Heading, Label, SplitPageLayout, Stack, useResponsiveValue} from '@primer/react'
import {ListUnorderedIcon, SyncIcon} from '@primer/octicons-react'
import {requestSample} from '../api/telemetry'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTask} from '../ui/async'
import {ActivityList} from './ActivityList'
import {ApplicationInventory} from './ApplicationInventory'
import {DataOverview} from './DataOverview'
import {DataSidebar} from './DataSidebar'
import {DeviceDetails} from './DeviceDetails'
import {NetworkDetails, PerformanceDetails, PermissionDetails, PowerDetails, StorageDetails} from './TelemetryDetails'
import {categories, categoryFromHash} from './categories'
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
  const heading = useId()
  const sidebarId = useId()
  const scroll = useRef<HTMLElement>(null)
  const menu = useRef<HTMLButtonElement>(null)
  const [showNavigation, setShowNavigation] = useState(false)
  const [sampleReady, setSampleReady] = useState(false)
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)
  const telemetry = useTelemetry(device, refreshDevice)
  const {connection, pending, error} = telemetry
  const stream = connection.online ? telemetry.stream : 'offline'
  const {history, trends, activity} = useTelemetryHistory(device.id, telemetry.history, stream === 'live', category === 'events')
  const task = useTask()
  const title = t(category === 'overview' ? 'dataCurrent' : categories[category].label)

  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [category])
  useEffect(() => { if (!narrow) setShowNavigation(false) }, [narrow])

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

  const details = {telemetry, history}
  const content = {
    overview: <DataOverview device={device} {...details} />,
    device: <DeviceDetails device={device} telemetry={telemetry} />,
    performance: <PerformanceDetails {...details} />,
    power: <PowerDetails {...details} />,
    network: <NetworkDetails {...details} />,
    storage: <StorageDetails {...details} />,
    applications: <ApplicationInventory deviceId={device.id} telemetry={telemetry}
      installed={new URLSearchParams(hash.split('?')[1]).get('inventory') === 'installed'} />,
    permissions: <PermissionDetails deviceId={device.id} telemetry={telemetry} />,
    events: <ActivityList history={history} pending={activity.pending && !activity.data} />,
  }[category]

  const hasTrends = ['overview', 'performance', 'power', 'network', 'storage'].includes(category)
  const historyError = category === 'events' ? activity.data?.error ?? activity.error
    : hasTrends && (trends.data?.error ?? trends.error)

  return <>
    <SplitPageLayout className={styles.workspace}>
      {!narrow && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarWidth}
        resizable widthStorageKey="filesharing.data-sidebar-width" aria-label={t('dataCategories')}>
        <div className={styles.sidebar}><DataSidebar selected={category} /></div>
      </SplitPageLayout.Sidebar>}
      <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
        <Stack as="main" ref={scroll} aria-labelledby={heading} className={styles.scroll} gap="none">
          <Stack padding={{narrow: 'normal', regular: 'spacious'}} gap="normal" className={styles.page}>
            {narrow && <Stack align="start">
              <Button ref={menu} size="medium" leadingVisual={ListUnorderedIcon} aria-haspopup="dialog" aria-expanded={showNavigation}
                aria-controls={sidebarId} onClick={() => setShowNavigation(true)}>{t('dataCategories')}</Button>
            </Stack>}
            <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap" gap="condensed">
              <Heading as="h1" id={heading} className={styles.sectionTitle}>{title}</Heading>
              <Stack direction="horizontal" align="center" gap="condensed" wrap="wrap">
                <span role="status"><Label variant={stream === 'live' ? 'success' : 'secondary'}>{t(streamLabels[stream])}</Label></span>
                {connection.online && connection.accessGranted
                  ? <Button size="medium" leadingVisual={SyncIcon} loading={task.busy} onClick={sample}>{t('dataSample')}</Button>
                  : connection.online
                    ? <Button size="medium" loading={authorizationBusy} onClick={authorize}>{t('allowConnection')}</Button>
                    : <Button size="medium" leadingVisual={SyncIcon} onClick={refresh}>{t('dataRefresh')}</Button>}
              </Stack>
            </Stack>
            <ErrorText error={task.error ?? authorizationError} />
            {sampleReady && <span role="status" className={styles.feedback}>{t('dataSampleReady')}</span>}
            {Boolean(error || historyError) && <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap">
              {error ? <ErrorText error={error} /> : <span role="alert">{t('dataHistoryError')}</span>}
              <Button size="medium" onClick={refresh}>{t('retry')}</Button>
            </Stack>}
            {pending ? <Loading /> : content}
          </Stack>
        </Stack>
      </SplitPageLayout.Content>
    </SplitPageLayout>
    {narrow && showNavigation && <Modal title={t('dataCategories')} onClose={() => setShowNavigation(false)} returnFocusRef={menu}>
      <div id={sidebarId}><DataSidebar selected={category} close={() => setShowNavigation(false)} /></div>
    </Modal>}
  </>
}
