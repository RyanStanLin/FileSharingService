import {useMemo, useRef, useState} from 'react'
import {Button} from '@primer/react'
import {PaperAirplaneIcon} from '@primer/octicons-react'
import {readAlert, readAlerts, type AlertJob} from '../api/alerts'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {useRefresh, useResource} from '../ui/async'
import explorer from '../ui/explorer.module.css'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {useCursorArchive} from '../ui/useCursorArchive'
import {useTableEnd} from '../ui/useTableEnd'
import {AlertComposer} from './AlertComposer'
import {AlertHistory} from './AlertHistory'
import {AlertInformation} from './AlertInformation'
import {draftFromRecord, newAlert, type AlertDraft} from './alertDraft'
import {useAlertEvents} from './useAlertEvents'
import {useAlertJob} from './useAlertJob'
import styles from './alerts.module.css'

export default function AlertWorkspace({device, authorize, authorizationBusy, authorizationError}: {
  device: Device; authorize: () => void; authorizationBusy: boolean; authorizationError: unknown
}) {
  const {t} = useLanguage()
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<AlertDraft>()
  const returnFocus = useRef<HTMLButtonElement>(null)
  const radio = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const history = useCursorArchive(device.id, readAlerts)
  const job = useAlertJob(device.id, history.refresh)
  const live = useAlertEvents(device.id, id => {
    if (job.waiting && (!id || id === job.item?.id)) job.refresh()
    if (!id || id !== job.item?.id) history.refresh()
  })
  useRefresh(!live, history.refresh, 15_000)

  const jobItem = job.item
  const archive = history.page?.items
  const items = useMemo(() => jobItem && !archive?.some(record => record.id === jobItem.id)
    ? [jobItem, ...(archive ?? [])] : archive ?? [], [archive, jobItem])
  const item = items.find(record => record.id === selected) ?? items[0]
  const record = archive?.find(record => record.id === item?.id)
  const detail = useResource(record?.id ?? null, signal => readAlert(device.id, record!.id, signal))
  const end = useTableEnd(history.loading || history.moreError ? undefined : history.page?.nextCursor ?? undefined, history.next, scroll)
  const {online, accessGranted} = device.connection
  const enabled = online && accessGranted
  const canSend = enabled && !job.waiting

  function compose(next: AlertDraft | undefined, trigger: HTMLButtonElement) {
    if (!canSend || !next) return
    returnFocus.current = trigger
    setDraft(next)
  }

  function queued(next: AlertJob, title: string) {
    job.track(next, title)
    setSelected(next.id)
    setDraft(undefined)
    if (scroll.current) scroll.current.scrollTop = 0
    requestAnimationFrame(() => radio.current?.focus())
  }

  return <>
    <AlertInformation item={item} detail={detail.data} feedback={<>
      {!online && <p className={styles.note}>{t('deviceOffline', {name: device.name})}</p>}
      {online && !accessGranted && <div className={styles.authorization}>
        <p className={styles.note}>{t('connectionHelp', {device: device.name})}</p>
        <Button size="medium" loading={authorizationBusy} onClick={authorize}>{t('allowConnection')}</Button>
      </div>}
      <ErrorText error={authorizationError} />
      {item?.outcome === 'queued' && <p className={styles.note} role="status">{t('alertWaiting')}</p>}
      <ErrorText error={job.error} />
      {detail.error != null && <Retry error={detail.error} refresh={detail.refresh} />}
    </>} actions={<>
      {item && <Button size="medium" leadingVisual={PaperAirplaneIcon} disabled={!canSend || !detail.data?.request}
        onClick={event => compose(detail.data && draftFromRecord(detail.data), event.currentTarget)}>{t('alertSendAgain')}</Button>}
      <Button size="medium" variant="primary" leadingVisual={PaperAirplaneIcon} disabled={!canSend}
        onClick={event => compose(newAlert(), event.currentTarget)}>{t('alertCompose')}</Button>
    </>} />
    <div ref={scroll} className={`${explorer.body} ${styles.history}`} tabIndex={0} role="region" aria-label={t('alertHistory')}>
      <AlertHistory items={items} selected={item?.id} select={setSelected} focusedRadio={radio} />
      {!history.page && history.loading === 'recent' && <Loading />}
      {history.error != null && <Retry error={history.error} refresh={history.refresh} />}
      {!items.length && history.page && !history.error && <p className={explorer.empty}>{t('alertEmpty')}</p>}
      {history.loading === 'older' && <Loading />}
      {history.moreError != null && <Retry error={history.moreError} refresh={history.next} />}
      <div ref={end} className={explorer.pageEnd} aria-hidden="true" />
    </div>
    {draft && <AlertComposer initial={draft} deviceId={device.id} enabled={canSend}
      returnFocusRef={returnFocus} close={() => setDraft(undefined)} queued={queued} />}
  </>
}
