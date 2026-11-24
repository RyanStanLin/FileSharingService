import {Button, Stack} from '@primer/react'
import {TerminalIcon} from '@primer/octicons-react'
import type {TerminalSession} from '../api/terminals'
import {useLanguage} from '../i18n'
import {Loading} from '../ui/Feedback'
import {TerminalRun} from './TerminalRun'
import {terminalHref} from './terminalLocation'
import type {TerminalRun as Run} from './useTerminalTranscript'
import styles from './quickRun.module.css'

export function QuickRunPreview({session, run, waiting, close}: {
  session: TerminalSession; run?: Run; waiting: boolean; close: () => void
}) {
  const {t} = useLanguage()
  const timestamp = new Date(session.createdAt).toISOString().slice(0, 19).replaceAll(/[^0-9]/g, '')
  return <section className={styles.preview} aria-label={t('terminalSession')}>
    <div className={styles.previewOutput}>
      {run ? <TerminalRun run={run} preview /> : waiting && <Loading message="terminalWaiting" />}
    </div>
    <Stack direction="horizontal" align="center" justify="space-between" wrap="wrap" gap="condensed" padding="tight" className={styles.saved}>
      <span>{t('terminalSavedAs', {name: 'command_session_' + timestamp})}</span>
      <Button as="a" href={terminalHref(session.id, session.deviceId)} size="small" leadingVisual={TerminalIcon}
        onClick={close}>{t('terminalShowTab')}</Button>
    </Stack>
  </section>
}
