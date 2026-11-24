import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {Button, SplitPageLayout, Stack, useResponsiveValue} from '@primer/react'
import {EyeIcon, ListUnorderedIcon} from '@primer/octicons-react'
import {createTerminal, readTerminalCatalog, type TerminalSession} from '../api/terminals'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {useRefresh, useResource, useTask} from '../ui/async'
import {ExplorerTitle} from '../ui/ExplorerHeader'
import {ErrorText, Loading, Retry} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {Timestamp} from '../ui/Timestamp'
import {TerminalComposer} from './TerminalComposer'
import {TerminalRun} from './TerminalRun'
import {TerminalSessionActions} from './TerminalSessionActions'
import {TerminalSidebar} from './TerminalSidebar'
import {openImmersive, terminalHref, terminalLocation} from './terminalLocation'
import {useTerminalTranscript} from './useTerminalTranscript'
import styles from './terminalLayout.module.css'

const sidebarWidth = {min: '176px', default: '232px', max: '480px'} as const
const noSessions: TerminalSession[] = []

export default function TerminalWorkspace({device, hash, authorize, authorizationBusy, authorizationError}: {
  device: Device; hash: string; authorize: () => void; authorizationBusy: boolean; authorizationError: unknown
}) {
  const {t} = useLanguage()
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)
  const [showSessions, setShowSessions] = useState(false)
  const [opened, setOpened] = useState<TerminalSession>()
  const [removed, setRemoved] = useState<string>()
  const sidebarButton = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const catalog = useResource(device.id, signal => readTerminalCatalog(device.id, signal))
  const task = useTask()
  const items = catalog.data ?? noSessions
  const available = opened && !items.some(session => session.id === opened.id) ? [...items, opened] : items
  const sorted = available.filter(session => session.id !== removed).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const requested = terminalLocation(hash).id
  const selected = requested ? sorted.find(session => session.id === requested) : sorted.find(session => session.state !== 'terminated') ?? sorted[0]
  const id = requested ?? selected?.id
  const transcript = useTerminalTranscript(device.id, id, selected?.state === 'terminated')
  const firstCommand = transcript.runs[0]?.line ?? selected?.firstCommand
  const session = transcript.session ?? selected
  const merged = session && firstCommand ? {...session, firstCommand} : session
  const records = merged && !sorted.some(item => item.id === merged.id) ? [merged, ...sorted]
    : sorted.map(item => item.id === merged?.id ? merged : item)
  const busy = records.some(record => record.state !== 'terminated')
  const allowed = device.connection.online && device.connection.accessGranted
  const ready = !catalog.pending || catalog.data != null
  const backgroundRefresh = !catalog.pending
  const refresh = catalog.refresh

  useRefresh(backgroundRefresh, refresh, 7000)
  useEffect(() => {
    if (transcript.session && selected && transcript.session.state !== selected.state && !catalog.pending && !catalog.error) {
      refresh()
    }
  }, [catalog.pending, catalog.error, refresh, transcript.session, selected])
  useEffect(() => { if (!narrow) setShowSessions(false) }, [narrow])
  useLayoutEffect(() => {
    follow.current = true
    if (scroll.current) scroll.current.scrollTop = 0
  }, [id])
  useLayoutEffect(() => {
    if (scroll.current && follow.current && session?.state !== 'terminated') scroll.current.scrollTop = scroll.current.scrollHeight
  }, [transcript.runs, session?.state])

  function open() {
    void task.run(async signal => {
      try {
        const next = await createTerminal(device.id, signal)
        if (signal.aborted) return
        setOpened(next)
        setShowSessions(false)
        window.location.hash = terminalHref(next.id, device.id)
      } finally { if (!signal.aborted) refresh() }
    })
  }

  const sidebar = (select?: () => void) => <TerminalSidebar sessions={records} current={id} name={device.name}
    pending={catalog.pending && !catalog.data} refresh={refresh} error={catalog.error}
    open={open} newDisabled={!allowed || busy || !ready} opening={task.busy} select={select} />
  const status = session?.state === 'starting' ? t('terminalOpening') : session?.state === 'terminating' ? t('terminalEnding')
    : session?.state === 'open' && !session.connected ? t('terminalDetached') : session?.state === 'terminated' ? t('terminalEnded') : undefined

  return <>
    <SplitPageLayout className={styles.workspace}>
      {!narrow && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarWidth}
        resizable widthStorageKey="filesharing.terminal-sidebar-width" aria-label={t('terminalSessions')}>
        {sidebar()}
      </SplitPageLayout.Sidebar>}
      <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
        <Stack as="main" gap="none" className={styles.pane}>
          {narrow && <div className={styles.mobileNavigation}>
            <Button ref={sidebarButton} size="medium" leadingVisual={ListUnorderedIcon} aria-haspopup="dialog"
              onClick={() => setShowSessions(true)}>{t('terminalSessions')}</Button>
          </div>}
          <Stack direction="horizontal" gap="condensed" justify="space-between" align="end" wrap="wrap" padding="normal"
            className={styles.sessionHeader}>
            <div className={styles.headerText}>
              <ExplorerTitle title={firstCommand ?? (id ? t('terminalSession') : t('terminal'))} />
              {session && <div className={styles.meta}><Timestamp value={session.createdAt} /></div>}
            </div>
            <Stack direction="horizontal" gap="condensed" wrap="wrap" align="end">
              {device.connection.online && !device.connection.accessGranted && <Button size="medium" loading={authorizationBusy}
                onClick={authorize}>{t('allowConnection')}</Button>}
              {session && <Button size="medium" leadingVisual={EyeIcon} onClick={() => openImmersive(session)}>{t('terminalOpenImmersive')}</Button>}
              {session?.state === 'terminated' && <TerminalSessionActions key={session.id} session={session} remove={() => {
                setRemoved(session.id)
                window.location.hash = terminalHref()
                refresh()
              }} />}
            </Stack>
          </Stack>
          <div ref={scroll} className={styles.transcript} tabIndex={0} onScroll={event => {
            const element = event.currentTarget
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          }}>
            <ErrorText error={task.error ?? authorizationError} />
            {transcript.error != null && <Retry error={transcript.error} refresh={transcript.retry} />}
            {id && transcript.pending && <Loading />}
            {(status || !device.connection.online) && <p className={styles.status} role="status">{status ?? t('deviceOffline', {name: device.name})}</p>}
            {transcript.runs.map(run => <TerminalRun key={run.id} run={run} />)}
          </div>
          {session && <TerminalComposer key={session.id} session={session} prompt={transcript.prompt}
            hasCommand={id => transcript.runs.some(run => run.id === id)} follow={() => { follow.current = true }} />}
        </Stack>
      </SplitPageLayout.Content>
    </SplitPageLayout>
    {narrow && showSessions && <Modal title={t('terminalSessions')} onClose={() => setShowSessions(false)} returnFocusRef={sidebarButton}>
      {sidebar(() => setShowSessions(false))}
    </Modal>}
  </>
}
