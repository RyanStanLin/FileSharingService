import {useEffect, useRef, useState, type ReactNode} from 'react'
import {Button, Heading, Stack, TreeView} from '@primer/react'
import {EyeClosedIcon, EyeIcon, FileDirectoryFillIcon, ShieldCheckIcon, ShieldIcon, ShieldXIcon} from '@primer/octicons-react'
import type {Entry, Location, Permission, Permissions, Share} from '../api/types'
import {useLanguage, type Translate} from '../i18n'
import {useRefreshSignal} from '../ui/async'
import {EntryIcon, ListEntryIcon} from './EntryIcon'
import entryStyles from './entryIcon.module.css'
import {homeLocation, locationOf, navigate, permissionFor} from './navigation'
import {useAutoPage} from './useAutoPage'
import {useDirectory, type DirectoryView} from './useDirectory'
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
  opened?: {location: Location; view: DirectoryView}
  rootPath?: string
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

function BranchItem({entry, marker, ...props}: BranchProps & {entry: Entry; marker?: ReactNode}) {
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
        {isFolder ? ({isExpanded}) => <EntryIcon entry={entry} expanded={isExpanded} />
          : <ListEntryIcon device={props.deviceId} rootId={scope.id} entry={entry} compact />}
      </TreeView.LeadingVisual>
      <span className={entry.hidden ? entryStyles.hiddenName : undefined} title={entry.name}>{entry.name}{marker}</span>
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
  const {deviceId, branch, hidden, revision, scope, opened} = props
  const shared = opened?.location.rootId === branch.rootId && opened.location.path === branch.path ? opened.view : undefined
  const own = useDirectory(deviceId, shared ? undefined : branch, {hidden, sort: 'name', direction: 'asc'}, 'background')
  useRefreshSignal(revision, own.refresh)
  const view = shared ?? own
  const previous = useRef<{hidden: boolean; entries: Entry[]}>(undefined)
  useEffect(() => {
    if (view.page) previous.current = {hidden, entries: view.entries}
  }, [hidden, view.entries, view.page])
  const entries = view.page ? view.entries : previous.current?.hidden === hidden ? previous.current.entries : []
  const tail = useAutoPage(view)
  const key = scope.id + ':' + branch.path
  const retry = view.moreError != null ? () => void view.next() : view.refresh

  return <>
    {entries.map((entry, index) => <BranchItem key={entry.path} entry={entry} {...props}
      marker={view.page?.nextOffset != null && index === entries.length - 1
        ? <span ref={tail} className={styles.pageMarker} aria-hidden="true" /> : undefined} />)}
    {(view.pending && !entries.length || view.loadingMore) &&
      <TreeView.Item id={key + ':loading'} aria-disabled="true">{t('loading')}</TreeView.Item>}
    {(view.error != null && !view.page || view.moreError != null) &&
      <TreeView.Item id={key + ':retry'} onSelect={retry}>{t('retry')}</TreeView.Item>}
  </>
}

export function Sidebar(props: SidebarProps) {
  const {t} = useLanguage()
  const {root, roots, rootPath, hidden, toggleHidden, onNavigate} = props
  return (
    <Stack gap="none" className={styles.sidebar}>
      <div className={styles.title}>
        <Heading as="h2" className={styles.heading}>{t('files')}</Heading>
        {rootPath && <div className={styles.path} title={rootPath}>{rootPath}</div>}
      </div>
      <div className={styles.tree}>
        <TreeView aria-label={t('folderTree')}>
          <Branch {...props} scope={root} branch={homeLocation(root)} />
        </TreeView>
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
        <Button size="medium" variant="invisible" block alignContent="start" leadingVisual={hidden ? EyeClosedIcon : EyeIcon}
          aria-pressed={hidden} onClick={toggleHidden} className={styles.hiddenToggle}>
          {t('showHidden')}
        </Button>
      </Stack></div>
    </Stack>
  )
}
