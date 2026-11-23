import {useEffect, useState, type CSSProperties} from 'react'
import {Stack} from '@primer/react'
import type {Snapshot} from '../api/telemetry'
import type {WindowDisplay, WindowSnapshot} from '../api/windows'
import {ApplicationIcon} from '../data/ApplicationIcon'
import {textValue} from '../data/format'
import {useLanguage} from '../i18n'
import {duration, number} from '../i18n/format'
import {byProcess, processUptime, projectWindows} from './windowGeometry'
import styles from './activity.module.css'

export function DisplayStage({deviceId, connectionId, display, label, aspect, snapshot, apps}: {
  deviceId: string
  connectionId: string
  display: WindowDisplay
  label: string
  aspect: number
  snapshot: WindowSnapshot
  apps?: Snapshot
}) {
  const {t, locale} = useLanguage()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const projected = projectWindows(snapshot.value.windows, display)
  const byPid = byProcess(apps)

  return <div className={styles.screen} style={{'--activity-aspect': aspect} as CSSProperties}>
    {projected.length === 0 ? <div className={styles.empty} role="status">{t('activityEmpty')}</div> :
      <ol className={styles.windowList} role="list" aria-label={t('activityScreenLabel', {display: label})}>
        {projected.map(({window, left, top, width, height}) => {
          const app = byPid.get(window.pid)
          const name = textValue(app?.name) ?? window.ownerName ?? t('activityWindowName', {id: number(window.id, locale)})
          const version = textValue(app?.version)
          const uptime = processUptime(app, now, apps?.observedAt)
          const runningFor = uptime === undefined ? undefined : duration(uptime, locale)
          const focused = window.id === snapshot.value.focusedWindowId && window.focused
          const title = [focused ? t('activityFocused', {name}) : name, version,
            runningFor && t('activityUptime', {duration: runningFor})].filter(Boolean).join(' · ')
          return <li className={styles.window} key={`${window.pid}:${window.id}`} data-window-id={window.id}
            data-focused={focused} aria-label={title} title={title}
            style={{'--window-left': `${100 * left}%`, '--window-top': `${100 * top}%`,
              '--window-width': `${100 * width}%`, '--window-height': `${100 * height}%`} as CSSProperties}>
            {window.occlusion.state !== 'covered' && <Stack className={styles.windowContent} gap="tight" align="center" justify="center">
              <ApplicationIcon device={deviceId} connectionId={connectionId} app={app} className={styles.appIcon} />
              <span className={styles.appName}>{name}{version && <span className={styles.version}> {version}</span>}</span>
              {runningFor && <span className={styles.uptime}>{runningFor}</span>}
            </Stack>}
          </li>
        })}
      </ol>}
  </div>
}
