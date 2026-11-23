import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react'
import {Button, SplitPageLayout, Stack, useResponsiveValue} from '@primer/react'
import {FileDirectoryIcon} from '@primer/octicons-react'
import {ApiError} from '../api/client'
import {readPermissions, readShares} from '../api/devices'
import {stat} from '../api/files'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {Loading, Retry, State} from '../ui/Feedback'
import {useRefresh, useResource} from '../ui/async'
import {ThumbnailProvider} from '../ui/thumbnails'
import feedbackStyles from '../ui/ui.module.css'
import {GoToDialog} from './GoToDialog'
import {LocationView} from './LocationView'
import {basename, homeLocation, permissionFor, useLocation} from './navigation'
import {PathBar} from './PathBar'
import {PermissionView} from './PermissionView'
import {ShareManager} from './ShareManager'
import {permissionBlocks, Sidebar} from './Sidebar'
import {useExplorer} from './useExplorer'
import {useLiveFolder} from './useLiveFolder'
import {useMoveClipboard} from './useMoveClipboard'
import styles from './workspace.module.css'

const sidebarSize = {min: '176px', default: '233px', max: '480px'} as const

interface Props {
  device: Device
  refreshDevice: () => void
  shareManager: boolean
  setShareManager: (show: boolean) => void
  goTo: boolean
  closeGoTo: () => void
}

export function Workspace({device, refreshDevice, shareManager, setShareManager, goTo, closeGoTo}: Props) {
  const {t} = useLanguage()
  const shares = useResource(device.id, signal => readShares(device.id, signal))
  const permissions = useResource(device.id, signal => readPermissions(device.id, signal))
  const visibleRoots = useMemo(() => {
    const writableFolders = (['downloads', 'documents', 'desktop'] as const).filter(kind => {
      const permission = permissions.data?.[kind]
      return permission?.state === 'allowed' && permission.phase === 'completed' && permission.writable === true
    })
    return (shares.data?.shares ?? []).map(share => share.folderPermissionWrites ? {...share, writableFolders} : share)
  }, [shares.data?.shares, permissions.data])
  const {root, location} = useLocation(visibleRoots)
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('filesharing.hidden') === 'true')
  const [mobileTree, setMobileTree] = useState(false)
  const sidebar = useId()
  const treeButton = useRef<HTMLButtonElement>(null)
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)
  const [fileRevision, setFileRevision] = useState(0)
  const [treeRevision, setTreeRevision] = useState(0)
  const refreshFile = useCallback(() => setFileRevision(value => value + 1), [])

  const kind = root && location ? permissionFor(root, location.path) : undefined
  const permission = kind ? permissions.data?.[kind] : undefined
  const blocked = permissionBlocks(permission)
  const activeLocation = blocked ? undefined : location
  const folder = activeLocation?.kind === 'folder' ? activeLocation : undefined
  const explorer = useExplorer(device.id, folder, hidden)
  const blockedByMac = folder && kind && explorer.view.error instanceof ApiError &&
    ['filesystem_access_denied', 'permission_denied'].includes(explorer.view.error.code)
  const rootInfo = useResource(root?.id ?? null, signal => stat(device.id, homeLocation(root!), signal, false, 'background'))
  const refreshCurrent = folder ? explorer.view.refresh : refreshFile
  const clipboard = useMoveClipboard(device.id, visibleRoots, refreshAfterEdit)
  useLiveFolder({
    device: device.id, location: blockedByMac ? undefined : activeLocation, ready: Boolean(explorer.view.page || activeLocation?.kind === 'file'),
    snapshotRevision: explorer.view.page?.snapshotRevision, refreshCurrent,
    refreshDevice, refreshPermissions: permissions.refresh,
  })
  useRefresh(true, permissions.refresh, 15_000)
  useRefresh(true, shares.refresh, 20_000)

  function refreshAfterEdit() {
    refreshCurrent()
    if (folder?.path === '') rootInfo.refresh()
    setTreeRevision(value => value + 1)
  }

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
  } else if (kind && (blocked || blockedByMac)) {
    view = <PermissionView key={kind} device={device} kind={kind}
      permission={blockedByMac ? {state: 'denied', phase: 'completed'} : permission}
      refresh={() => {
        permissions.refresh()
        if (blockedByMac) explorer.view.refresh()
      }} displayName={basename(location.path.split('/')[0])} />
  } else {
    view = <LocationView key={root.id + ':' + location.kind + ':' + location.path}
      device={device} share={root} location={location} revision={fileRevision} explorer={explorer}
      clipboard={clipboard} refresh={refreshAfterEdit}
      rootEntry={rootInfo.data} rootPending={rootInfo.pending} />
  }

  useEffect(() => {
    if (permissions.error instanceof ApiError && permissions.error.code === 'device_unavailable') refreshDevice()
  }, [permissions.error, refreshDevice])

  const sidebarContent = root && location ? (
    <Sidebar key={root.id} deviceId={device.id} roots={visibleRoots} root={root} location={location}
      hidden={hidden} toggleHidden={toggleHidden} permissions={permissions.data ?? {}} revision={treeRevision}
      opened={folder ? {location: folder, view: explorer.view} : undefined} rootPath={rootInfo.data?.fullPath}
      onNavigate={() => setMobileTree(false)} />
  ) : null

  return (
    <ThumbnailProvider>
      <SplitPageLayout className={styles.workspace}>
        {!narrow && sidebarContent && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarSize}
          resizable aria-label={t('folderTree')} widthStorageKey="filesharing.sidebar-width">
          {sidebarContent}
        </SplitPageLayout.Sidebar>}
        <SplitPageLayout.Content key="file-content" width="full" padding="none" className={styles.content}>
          <Stack className={styles.pane} gap="none">
            {root && <div className={styles.mobileNavigation}>
              <Button ref={treeButton} size="medium" leadingVisual={FileDirectoryIcon} aria-haspopup="dialog" aria-expanded={mobileTree}
                aria-controls={sidebar} onClick={() => setMobileTree(open => !open)}>{t('folderTree')}</Button>
            </div>}
            <div className={clipboard.status || clipboard.error ? styles.pageAction : undefined}>
              <div role="status">{clipboard.status}</div>
              {clipboard.error && <div role="alert" className={feedbackStyles.error}>{clipboard.error}</div>}
            </div>
            {view}
            {root && location && <PathBar location={location} share={root} />}
          </Stack>
        </SplitPageLayout.Content>
      </SplitPageLayout>
      {narrow && mobileTree && sidebarContent && (
        <Modal title={t('folderTree')} returnFocusRef={treeButton} onClose={() => setMobileTree(false)}>
          <div id={sidebar} className={styles.mobileTree}>{sidebarContent}</div>
        </Modal>
      )}
      {shareManager && shares.data && <ShareManager device={device.id} local={shares.data.local}
        roots={shares.data.roots} refresh={shares.refresh} close={() => setShareManager(false)} />}
      {goTo && location && shares.data && <GoToDialog device={device.id} shares={visibleRoots}
        location={location} rootEntry={rootInfo.data} hidden={hidden} close={closeGoTo} />}
    </ThumbnailProvider>
  )
}
