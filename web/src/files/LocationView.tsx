import {useState} from 'react'
import {download} from '../api/transfers'
import type {Device, Entry, Location, Share} from '../api/types'
import {ErrorText} from '../ui/Feedback'
import {useTask} from '../ui/async'
import type {DownloadSelection, FileAction} from './actions'
import {FileDialog} from './FileDialog'
import {FilePanel} from './FilePanel'
import {FolderPanel} from './FolderPanel'
import {locationOf, navigate, parent} from './navigation'
import type {Explorer} from './useExplorer'
import styles from './workspace.module.css'

export function LocationView({device, share, location, visibleRoots, hidden, revision, explorer, refresh, rootEntry, rootPending}: {
  device: Device
  share: Share
  location: Location
  visibleRoots: Share[]
  hidden: boolean
  revision: number
  explorer: Explorer
  rootEntry?: Entry
  rootPending: boolean
  refresh: () => void
}) {
  const [action, setAction] = useState<FileAction>()
  const task = useTask()

  const onDownload: DownloadSelection = selection => {
    void task.run(async signal => {
      const entries = typeof selection === 'function' ? await selection(signal) : selection
      if (typeof selection === 'function' && !entries.length) return
      await download(device.id, location, entries, signal)
    })
  }

  function changed(updated?: Entry) {
    setAction(undefined)
    refresh()
    if (location.kind !== 'file') return
    if (action?.kind === 'rename' && updated) navigate(locationOf(share.id, updated))
    if (action?.kind === 'remove' || action?.kind === 'trash' || action?.kind === 'move') {
      navigate({...location, kind: 'folder', path: parent(location.path)})
    }
  }

  const common = {share, location, revision, onAction: setAction, onDownload, downloadBusy: task.busy}
  return (
    <>
      {task.error != null && <div className={styles.pageAction}><ErrorText error={task.error} /></div>}
      {location.kind === 'file'
        ? <FilePanel device={device.id} {...common} />
        : <FolderPanel device={device} explorer={explorer} rootEntry={rootEntry} rootPending={rootPending} {...common} />}
      {action && <FileDialog action={action} deviceId={device.id} share={share} location={location} hidden={hidden}
        roots={visibleRoots} directoryEntries={explorer.view.entries} close={() => setAction(undefined)} changed={changed} refresh={refresh} />}
    </>
  )
}
