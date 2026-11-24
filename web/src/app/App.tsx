import {lazy, Suspense, useEffect, useRef, useState} from 'react'
import {Button, Stack} from '@primer/react'
import {readDevices, setAccess} from '../api/devices'
import {useDeviceEvents} from '../api/events'
import type {Device} from '../api/types'
import {primaryModifier} from '../files/explorerInput'
import {Workspace} from '../files/Workspace'
import {useLanguage} from '../i18n'
import {Loading, Retry, State} from '../ui/Feedback'
import {useRefresh, useResource, useTask} from '../ui/async'
import {Header} from './Header'
import {SetupDialog} from './SetupDialog'
import {useAppPage} from './useAppPage'
import {useSession} from './useSession'
import styles from './shell.module.css'

const selectedDevice = 'filesharing.device'
const ignore = () => undefined
const DataWorkspace = lazy(() => import('../data/DataWorkspace'))
const WindowActivity = lazy(() => import('../activity/WindowActivity'))
const AlertWorkspace = lazy(() => import('../alerts/AlertWorkspace'))

export function App() {
  const {t} = useLanguage()
  const {page, filesHref, hash, resetFileLocation} = useAppPage()
  const session = useSession()
  const unlocked = session.current?.unlocked === true
  const devices = useResource(unlocked ? 'devices' : null, readDevices)
  const [deviceId, setDeviceId] = useState(() => sessionStorage.getItem(selectedDevice))
  const [shareManager, setShareManager] = useState(false)
  const [goTo, setGoTo] = useState(false)
  const connectionTask = useTask()
  const accessRef = useRef<HTMLButtonElement>(null)
  const lastDevice = useRef<Device>(undefined)
  const items = devices.data ?? []
  const device = items.find(item => item.id === deviceId) ?? items.find(item => item.connection.online) ?? items[0]

  useEffect(() => {
    if (!unlocked) return
    lastDevice.current = device
    if (device && device.id !== deviceId) {
      setDeviceId(device.id)
      sessionStorage.setItem(selectedDevice, device.id)
    }
  }, [unlocked, device, deviceId])
  useRefresh(unlocked, devices.refresh, 8000)
  useDeviceEvents(page !== 'data' && unlocked && device?.connection.online && !device.connection.accessGranted ? device.id : null,
    undefined, devices.refresh, ignore, ignore)

  function select(item: Device) {
    setShareManager(false)
    setGoTo(false)
    setDeviceId(item.id)
    sessionStorage.setItem(selectedDevice, item.id)
    resetFileLocation()
    if (page === 'files') window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }

  function authorize(enabled: boolean) {
    if (!device?.connection.online || !device.connection.connectionId) return
    void connectionTask.run(async () => {
      try { await setAccess(device, enabled) } finally { devices.refresh() }
    })
  }

  let content
  if (session.initial.error && !session.current) {
    content = <Retry error={session.initial.error} refresh={session.initial.refresh} />
  } else if (!session.current) {
    content = <Loading />
  } else if (!unlocked) {
    content = <State tone="locked" title={t('locked')} description={t('lockedHelp')}
      error={session.setup ? undefined : session.task.error} />
  } else if (devices.error && !device) {
    content = <Retry error={devices.error} refresh={devices.refresh} />
  } else if (devices.pending && !device) {
    content = <Loading />
  } else if (!device) {
    content = <State title={t('noDevices')} description={t('waitingDevice')} />
  } else if (page === 'alerts') {
    content = <Suspense fallback={<Loading />}>
      <AlertWorkspace key={device.id} device={device} authorize={() => authorize(true)}
        authorizationBusy={connectionTask.busy} authorizationError={connectionTask.error} />
    </Suspense>
  } else if (!device.connection.online) {
    content = <State title={t('deviceOffline', {name: device.name})} />
  } else if (!device.connection.accessGranted) {
    content = <State tone="locked" title={t('connectionNeeded')}
      description={t(page === 'activity' ? 'activityAuthorize' : 'connectionHelp', {device: device.name})}
      error={connectionTask.error}>
      <Button size="medium" loading={connectionTask.busy} variant="primary" onClick={() => authorize(true)}>
        {t('allowConnection')}
      </Button>
    </State>
  } else if (page === 'activity' && device.connection.connectionId) {
    content = <Suspense fallback={<Loading message="activityLoading" />}>
      <WindowActivity key={`${device.id}:${device.connection.connectionId}`} deviceId={device.id}
        connectionId={device.connection.connectionId} refreshDevice={devices.refresh} />
    </Suspense>
  }

  const workspace = page === 'files' && unlocked && device?.connection.online && device.connection.accessGranted
  useEffect(() => {
    if (!workspace) {
      setGoTo(false)
      return
    }
    function openPath(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || !primaryModifier(event) || !event.shiftKey ||
        event.altKey || event.key.toLowerCase() !== 'g' || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      setGoTo(true)
    }
    document.addEventListener('keydown', openPath)
    return () => document.removeEventListener('keydown', openPath)
  }, [workspace])
  return (
    <Stack gap="none" className={styles.app}>
      <Header devices={items} device={device ?? (!unlocked ? lastDevice.current : undefined)} unlocked={unlocked}
        ready={Boolean(session.current)} busy={session.task.busy} toggle={session.change} select={select}
        page={page} filesHref={filesHref} shares={workspace ? () => setShareManager(true) : undefined}
        revoke={() => authorize(false)} accessRef={accessRef}
        openPath={workspace ? () => setGoTo(true) : undefined} />
      {workspace
        ? <Workspace key={device.id + device.connection.connectionId} device={device} refreshDevice={devices.refresh}
            shareManager={shareManager} setShareManager={setShareManager} goTo={goTo} closeGoTo={() => setGoTo(false)} />
        : page === 'data' && unlocked && device
          ? <Suspense fallback={<Stack as="main" gap="none" className={styles.main}><Loading /></Stack>}>
              <DataWorkspace key={device.id} device={device} hash={hash} refreshDevice={devices.refresh}
                authorize={() => authorize(true)} authorizationBusy={connectionTask.busy} authorizationError={connectionTask.error} />
            </Suspense>
          : <Stack as="main" gap="none" className={page === 'alerts' ? styles.workArea : styles.main}>{content}</Stack>}
      {session.setup && <SetupDialog submit={session.initialize} close={session.closeSetup}
        busy={session.task.busy} error={session.task.error} returnFocusRef={accessRef} />}
    </Stack>
  )
}
