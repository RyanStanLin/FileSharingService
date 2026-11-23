import {useId, useState} from 'react'
import {Heading, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {textValue} from '../data/format'
import {useLanguage} from '../i18n'
import {number} from '../i18n/format'
import {ChoiceMenu} from '../ui/ChoiceMenu'
import {Loading, Retry, State} from '../ui/Feedback'
import {TimestampDetails} from '../ui/TimestampDetails'
import {ThumbnailProvider} from '../ui/thumbnails'
import {DisplayStage} from './DisplayStage'
import {useWindowActivity} from './useWindowActivity'
import {byProcess, displayResolution} from './windowGeometry'
import styles from './activity.module.css'

export default function WindowActivity({deviceId, connectionId, refreshDevice}: {
  deviceId: string
  connectionId: string
  refreshDevice: () => void
}) {
  const {t, locale} = useLanguage()
  const heading = useId()
  const [displayId, setDisplayId] = useState<number>()
  const feed = useWindowActivity(deviceId, refreshDevice)
  const {snapshot} = feed
  const value = snapshot?.value
  const displays = (value?.available ? value.displays : []).filter(display => display.bounds.width > 0 && display.bounds.height > 0)
  const monitors = displays.map((display, index) => {
    const resolution = displayResolution(display, feed.displays)
    const label = display.main ? t('activityMainDisplay') : t('activityDisplay', {number: number(index + 1, locale)})
    const dimensions = resolution && t('activityResolution', {
      width: number(resolution.width, locale), height: number(resolution.height, locale),
    })
    const {width, height} = resolution ?? display.bounds
    return {display, label, dimensions, aspect: width / height}
  })
  const monitor = monitors.find(item => item.display.id === displayId) ?? monitors.find(item => item.display.main) ?? monitors[0]
  const foreground = value?.activePid == null ? undefined : textValue(byProcess(feed.apps).get(value.activePid)?.name)
    ?? value.windows.find(window => window.id === value.focusedWindowId)?.ownerName
  const status = snapshot && t(feed.error ? 'activityResume' : feed.mode === 'live' ? 'dataLive' : 'dataPolling')

  let content
  if (snapshot && monitor) {
    content = <DisplayStage deviceId={deviceId} connectionId={connectionId} display={monitor.display}
      label={monitor.label} aspect={monitor.aspect} snapshot={snapshot} apps={feed.apps} />
  } else if (feed.error instanceof ApiError && feed.error.code === 'unsupported') {
    content = <State description={t('activityUnsupported')} />
  } else if (feed.error) {
    content = <Retry error={feed.error} refresh={feed.retry} />
  } else if (value) {
    content = <div className={styles.empty} role="status">{t(value.available ? 'activityNoDisplay' : 'activityUnavailable')}</div>
  } else {
    content = <Loading message="activityLoading" />
  }

  return <section className={styles.workspace} aria-labelledby={heading}>
    <Stack className={styles.panel} gap="none">
      <Stack as="header" className={styles.header} direction="horizontal" justify="space-between"
        align="center" wrap="wrap" gap="condensed" paddingInline="normal" paddingBlock="cozy">
        <Stack className={styles.heading} gap="tight">
          <Heading as="h1" id={heading} variant="small">{t('activityTitle')}</Heading>
          {value?.available && <span className={styles.summary} role="status">
            {foreground ? t('activityForeground', {name: foreground}) : t('activityNoForeground')}
          </span>}
        </Stack>
        <Stack direction="horizontal" className={styles.controls} align="center" wrap="wrap" gap="condensed">
          {value?.truncated && <span className={styles.status}>{t('activityTruncated')}</span>}
          {monitors.length > 1 && <ChoiceMenu block className={styles.displayControl} label={t('activityDisplayName')}
            value={monitor.display.id} onChange={setDisplayId} options={monitors.map(({display, label, dimensions}) => ({
              value: display.id, label: dimensions ? t('activityDisplayOption', {display: label, resolution: dimensions}) : label,
            }))} />}
          {monitors.length === 1 && monitor.dimensions && <span className={styles.status}>{monitor.dimensions}</span>}
          {status && <span className={styles.status} role="status">{status}</span>}
          {snapshot && <span className={styles.status}><TimestampDetails value={snapshot.observedAt} label="dataUpdated" /></span>}
        </Stack>
      </Stack>
      <div className={styles.viewport}><ThumbnailProvider>{content}</ThumbnailProvider></div>
    </Stack>
  </section>
}
