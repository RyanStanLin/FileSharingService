import {Button, Heading, Stack} from '@primer/react'
import {ArrowLeftIcon, DownloadIcon} from '@primer/octicons-react'
import {terminalDownload} from '../api/terminals'
import {useLanguage} from '../i18n'
import {Loading, Retry} from '../ui/Feedback'
import {TerminalComposer} from './TerminalComposer'
import {terminalHref} from './terminalLocation'
import {useImmersiveScreen} from './useImmersiveScreen'
import styles from './immersive.module.css'

export default function ImmersiveTerminal({deviceId, id}: {deviceId: string; id: string}) {
  const {t} = useLanguage()
  const {host, pending, session, prompt, hasCommand, error, retry} = useImmersiveScreen(deviceId, id)
  const status = session?.state === 'starting' ? t('terminalOpening') : session?.state === 'terminating' ? t('terminalEnding')
    : session?.state === 'open' && !session.connected ? t('terminalDetached') : session?.state === 'terminated' ? t('terminalEnded') : undefined
  return <Stack as="main" className={styles.immersive} gap="none" aria-label={t('terminalImmersive')}>
    <Stack as="header" direction="horizontal" align="center" justify="space-between" wrap="wrap" gap="condensed"
      paddingBlock="cozy" paddingInline="normal" className={styles.toolbar}>
      <Button as="a" href={terminalHref(id, deviceId)} size="medium" leadingVisual={ArrowLeftIcon}>{t('terminalBack')}</Button>
      <Heading as="h1" className={styles.title}>{t('terminalImmersive')}</Heading>
      <Button as="a" href={terminalDownload({deviceId, id})} size="medium" leadingVisual={DownloadIcon} download>{t('terminalDownload')}</Button>
    </Stack>
    {pending && <Loading message="terminalOpening" />}
    {status && <p className={styles.status} role="status">{status}</p>}
    {error != null && <Retry error={error} refresh={retry} />}
    <div className={styles.screen} ref={host} />
    {session && <TerminalComposer session={session} prompt={prompt} hasCommand={hasCommand} />}
  </Stack>
}
