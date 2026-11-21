import {useState} from 'react'
import {Button, Heading, Stack, TreeView} from '@primer/react'
import {EyeClosedIcon, EyeIcon, FileDirectoryFillIcon, FileDirectoryOpenFillIcon, FileIcon, ShieldCheckIcon, ShieldIcon, ShieldXIcon} from '@primer/octicons-react'
import {stat} from '../api/files'
import type {Entry, Location, Permission, Permissions, Share} from '../api/types'
import {useLanguage, type Translate} from '../i18n'
import {useRefreshSignal, useResource} from '../ui/async'
import {ErrorText} from '../ui/Feedback'
import {homeLocation, locationOf, navigate, permissionFor} from './navigation'
import {useDirectory} from './useDirectory'
import styles from './sidebar.module.css'

interface SidebarProps {
  deviceId: string
  roots: Share[]
  root: Share
  location: Location
  hidden: boolean
  toggleHidden: () => void
  permissions: Permissions
  revision: number
  onNavigate: () => void
}

interface BranchProps extends SidebarProps {
  scope: Share
  branch: Location
}

export function permissionBlocks(permission: Permission | undefined) {
  return permission?.phase === 'requesting' ||
    permission?.state === 'notDetermined' || permission?.state === 'denied' || permission?.state === 'requiresSystemSettings'
}

function permissionIcon(permission: Permission | undefined, t: Translate) {
  const Icon = permission?.state === 'allowed' ? ShieldCheckIcon : permission?.state === 'denied' ? ShieldXIcon : ShieldIcon
  const status = t(permission?.phase === 'requesting' ? 'requesting' : permission?.state ?? 'unknown')
  return <TreeView.TrailingVisual label={status}><span title={status}><Icon size={16} /></span></TreeView.TrailingVisual>
}

function BranchItem({entry, ...props}: BranchProps & {entry: Entry}) {
  const {t} = useLanguage()
  const {scope, location, onNavigate, permissions} = props
  const target = locationOf(scope.id, entry)
  const current = scope.id === location.rootId && location.path === target.path
  const isAncestor = scope.id === location.rootId && location.path.startsWith(target.path + '/')
  const [expansion, expand] = useState<boolean>()
  const expanded = expansion ?? (isAncestor || current)
  const kind = permissionFor(scope, target.path)
  const permission = kind ? permissions[kind] : undefined
  const isFolder = target.kind === 'folder'
  const blocked = permissionBlocks(permission)
  const activate = () => {
    navigate(target)
    if (isFolder && !blocked) expand(true)
    onNavigate()
  }

  return (
    <TreeView.Item id={scope.id + ':' + entry.path} current={current}
      onSelect={activate} expanded={isFolder ? !blocked && expanded : null}
      onExpandedChange={next => { if (blocked && next) activate(); else expand(next) }}>
      <TreeView.LeadingVisual>
        {isFolder ? ({isExpanded}) => isExpanded
          ? <FileDirectoryOpenFillIcon className={styles.folderIcon} size={16} />
          : <FileDirectoryFillIcon className={styles.folderIcon} size={16} />
          : <FileIcon size={16} />}
      </TreeView.LeadingVisual>
      <span title={entry.name}>{entry.name}</span>
      {kind && target.path.indexOf('/') === -1 && permissionIcon(permission, t)}
      {isFolder && (
        <TreeView.SubTree state={!blocked && expanded ? "done" : "initial"}>
          {!blocked && expanded && <Branch {...props} branch={target} />}
        </TreeView.SubTree>
      )}
    </TreeView.Item>
  )
}

function Branch(props: BranchProps) {
  const {t} = useLanguage()
  const {deviceId, branch, hidden, revision, scope} = props
  const view = useDirectory(deviceId, branch, {hidden, sort: 'name', direction: 'asc', limit: 200})
  useRefreshSignal(revision, view.refresh)
  const key = scope.id + ':' + branch.path

  return <>
    {view.entries.map(entry => <BranchItem key={entry.path} entry={entry} {...props} />)}
    {view.pending && !view.page && <TreeView.Item id={key + ':loading'} aria-disabled="true">{t('loading')}</TreeView.Item>}
    {view.error != null && <TreeView.Item id={key + ':retry'} onSelect={view.refresh}>{t('retry')}</TreeView.Item>}
    {view.page?.nextOffset != null && (
      <TreeView.Item id={key + ':more'} onSelect={() => void view.next()} aria-busy={view.loadingMore}>
        {t(view.loadingMore ? 'loading' : 'moreEntries')}
      </TreeView.Item>
    )}
  </>
}

export function Sidebar(props: SidebarProps) {
  const {t} = useLanguage()
  const {root, roots, deviceId, hidden, toggleHidden, onNavigate} = props
  const summary = useResource(root.id, signal => stat(deviceId, homeLocation(root), signal, false))
  return (
    <Stack gap="none" className={styles.sidebar}>
      <div className={styles.title}>
        <Heading as="h2" className={styles.heading}>{t('files')}</Heading>
        {summary.data && <div className={styles.path} title={summary.data.fullPath}>{summary.data.fullPath}</div>}
      </div>
      <div className={styles.tree}>
        <TreeView aria-label={t('folderTree')}>
          <Branch {...props} scope={root} branch={homeLocation(root)} />
        </TreeView>
        <ErrorText error={summary.error} />
      </div>
      {roots.length > 1 && <div className={styles.roots}>
        <TreeView aria-label={t('sharedFolders')} flat>
          {roots.map(scope => <TreeView.Item key={scope.id} id={scope.id} current={scope.id === root.id}
            onSelect={() => { navigate(homeLocation(scope)); onNavigate() }}>
            <TreeView.LeadingVisual><FileDirectoryFillIcon size={16} className={styles.folderIcon} /></TreeView.LeadingVisual>
            {scope.primary ? t('userFolder') : scope.label}
          </TreeView.Item>)}
        </TreeView>
      </div>}
      <div className={styles.options}><Stack gap="tight">
        <strong>{t('viewOption')}</strong>
        <Button size="medium" variant="invisible" leadingVisual={hidden ? EyeClosedIcon : EyeIcon}
          aria-pressed={hidden} onClick={toggleHidden} className={styles.hiddenToggle}>
          {t('showHidden')}
        </Button>
      </Stack></div>
    </Stack>
  )
}
