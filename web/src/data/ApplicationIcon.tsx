import {AppsIcon} from '@primer/octicons-react'
import {appIcon, type DataObject} from '../api/telemetry'
import {useThumbnail, useThumbnailVisibility} from '../ui/thumbnails'
import styles from '../ui/thumbnail.module.css'
import {textValue} from './format'

export function ApplicationIcon({device, app, connectionId}: {device: string; app: DataObject; connectionId?: string}) {
  const {anchor, visible} = useThumbnailVisibility()
  const id = textValue(app.applicationId)
  const key = id && textValue(app.installPath) && connectionId && visible ? JSON.stringify([
    'app', device, connectionId, id, app.iconHash ?? [app.version, app.build, app.installPath],
  ]) : null
  const {url} = useThumbnail(device, key, signal => appIcon(device, id!, signal))
  return <span ref={anchor} className={styles.frame}>
    {url ? <img src={url} className={styles.image} alt="" draggable={false} /> : <AppsIcon />}
  </span>
}
