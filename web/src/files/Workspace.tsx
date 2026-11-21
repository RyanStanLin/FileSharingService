import {useCallback, useEffect, useId, useRef, useState} from 'react'
import {Button, SplitPageLayout, Stack} from '@primer/react'
import {FileDirectoryIcon} from '@primer/octicons-react'
import {ApiError} from '../api/client'
import {readPermissions, readShares} from '../api/devices'
import {useDeviceEvents} from '../api/events'
import type {Device, Location} from '../api/types'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {Loading, Retry, State} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {LocationView} from './LocationView'
import {basename, parent, permissionFor, useLocation} from './navigation'
import {PathBar} from './PathBar'
import {PermissionView} from './PermissionView'
import {ShareManager} from './ShareManager'
import {permissionBlocks, Sidebar} from './Sidebar'
import styles from './workspace.module.css'

const sidebarWidth = '233px'
const sidebarSize = {min: sidebarWidth, default: sidebarWidth, max: sidebarWidth} as const

interface Props {
  device: Device
  refreshDevice: () => void
  shareManager: boolean
  setShareManager: (show: boolean) => void
}

export function Workspace({device, refreshDevice, shareManager, setShareManager}: Props) {
  const {t} = useLanguage()
  const shares = useResource(device.id, signal => readShares(device.id, signal))
  const permissions = useResource(device.id, signal => readPermissions(device.id, signal))
  const {root, location} = useLocation(shares.data?.shares ?? [])
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('filesharing.hidden') === 'true')
  const [mobileTree, setMobileTree] = useState(false)
  const sidebar = useId()
  const treeButton = useRef<HTMLButtonElement>(null)
  const [revision, setRevision] = useState(0)
  const eventDebounce = useRef(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const onChange = useCallback(() => {
    if (eventDebounce.current) return
    eventDebounce.current = window.setTimeout(() => {
      eventDebounce.current = 0
      refresh()
    }, 350)
  }, [refresh])
  useEffect(() => () => window.clearTimeout(eventDebounce.current), [])

  const kind = root && location ? permissionFor(root, location.path) : undefined
  const permission = kind ? permissions.data?.[kind] : undefined
  const blocked = permissionBlocks(permission)
  const watched: Location | undefined = location && !blocked
    ? {...location, path: location.kind === 'file' ? parent(location.path) : location.path, kind: 'folder'}
    : undefined
  useDeviceEvents(device.id, watched, refreshDevice, permissions.refresh, onChange)
  useRefresh(true, permissions.refresh, 15_000)
  useRefresh(true, shares.refresh, 20_000)
  useRefresh(Boolean(watched), refresh, 30_000)

  function toggleHidden() {
    setHidden(!hidden)
    sessionStorage.setItem('filesharing.hidden', String(!hidden))
  }

  let view
  if (shares.error && !shares.data) {
    view = <Retry error={shares.error} refresh={shares.refresh} />
  } else if (!shares.data) {
    view = <Loading />
  } else if (!root || !location) {
    view = <State title={t('emptyShares')} description={t('emptySharesHelp')}>
      <Button size="medium" onClick={() => setShareManager(true)}>{t('sharedFolders')}</Button>
    </State>
  } else if (kind && blocked) {
    view = <PermissionView key={kind} device={device} kind={kind} permission={permission}
      refresh={permissions.refresh} displayName={basename(location.path.split('/')[0])} />
  } else {
    view = <LocationView key={root.id + ':' + location.kind + ':' + location.path}
      device={device} share={root} location={location} hidden={hidden} revision={revision}
      visibleRoots={shares.data.shares} refresh={refresh} />
  }

  useEffect(() => {
    if (permissions.error instanceof ApiError && permissions.error.code === 'device_unavailable') refreshDevice()
  }, [permissions.error, refreshDevice])

  const sidebarContent = root && location ? (
    <Sidebar key={root.id} deviceId={device.id} roots={shares.data?.shares ?? []} root={root} location={location}
      hidden={hidden} toggleHidden={toggleHidden} permissions={permissions.data ?? {}} revision={revision}
      onNavigate={() => setMobileTree(false)} />
  ) : null

  return (
    <>
      <SplitPageLayout className={styles.workspace}>
        {sidebarContent && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarSize}
          className={styles.sidePane} hidden={{narrow: true, regular: false}}>
          {sidebarContent}
        </SplitPageLayout.Sidebar>}
        <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
          <Stack className={styles.pane} gap="none">
            {root && <div className={styles.mobileNavigation}>
              <Button ref={treeButton} size="medium" leadingVisual={FileDirectoryIcon} aria-haspopup="dialog" aria-expanded={mobileTree}
                aria-controls={sidebar} onClick={() => setMobileTree(open => !open)}>{t('folderTree')}</Button>
            </div>}
            {view}
            {root && location && <PathBar location={location} share={root} />}
          </Stack>
        </SplitPageLayout.Content>
      </SplitPageLayout>
      {mobileTree && sidebarContent && (
        <Modal title={t('folderTree')} returnFocusRef={treeButton} onClose={() => setMobileTree(false)}>
          <div id={sidebar} className={styles.mobileTree}>{sidebarContent}</div>
        </Modal>
      )}
      {shareManager && shares.data && <ShareManager device={device.id} local={shares.data.local}
        roots={shares.data.roots} refresh={shares.refresh} close={() => setShareManager(false)} />}
    </>
  )
}
