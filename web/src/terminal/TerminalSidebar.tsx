import {useState} from 'react'
import {Button, Heading, NavList, Stack, TextInput} from '@primer/react'
import {SearchIcon, TerminalIcon} from '@primer/octicons-react'
import type {TerminalSession} from '../api/terminals'
import {useLanguage} from '../i18n'
import {Loading, Retry} from '../ui/Feedback'
import {Timestamp} from '../ui/Timestamp'
import {terminalHref} from './terminalLocation'
import styles from './terminalLayout.module.css'

export function TerminalSidebar({sessions, current, name, pending, error, refresh, open, newDisabled, opening, select}: {
  sessions: TerminalSession[]; current?: string; name: string; pending: boolean; error: unknown; refresh: () => void
  open: () => void; opening: boolean; newDisabled: boolean; select?: () => void
}) {
  const {t} = useLanguage()
  const [query, setQuery] = useState('')
  const filter = query.trim().toLocaleLowerCase()
  const title = (session: TerminalSession) => session.firstCommand ?? t('terminalSession')
  const matches = sessions.filter(session => title(session).toLocaleLowerCase().includes(filter))
  const active = matches.filter(session => session.state !== 'terminated')
  const archived = matches.filter(session => session.state === 'terminated')

  function item(session: TerminalSession) {
    return <NavList.Item key={session.id} href={terminalHref(session.id, session.deviceId)}
      aria-current={current === session.id ? 'page' : undefined} onClick={select}>
      <span className={styles.sessionTitle} title={title(session)}>{title(session)}</span>
      <span className={styles.sessionTime}><Timestamp value={session.createdAt} /></span>
    </NavList.Item>
  }

  return <Stack gap="none" className={styles.sidebar}>
    <div className={styles.sidebarTop}>
      <Heading as="h2" className={styles.sidebarTitle}>{t('terminal')}</Heading>
      <p className={styles.caption}>{t('terminalOnDevice', {name})}</p>
      <TextInput className={styles.search} block size="medium" leadingVisual={SearchIcon} value={query} type="search"
        aria-label={t('terminalSearch')} placeholder={t('terminalSearch')} onChange={event => setQuery(event.currentTarget.value)} />
    </div>
    <div className={styles.sessions}>
      <NavList aria-label={t('terminalSessions')} className={styles.navigation} disableItemGap>
        {active.length > 0 && <NavList.Group title={t('terminalActive')} hideDivider>{active.map(item)}</NavList.Group>}
        {archived.length > 0 && <NavList.Group title={t('terminalHistory')} hideDivider={!active.length}
          className={styles.archiveGroup}>{archived.map(item)}</NavList.Group>}
      </NavList>
      {pending && <Loading />}
      {error != null && <Retry error={error} refresh={refresh} />}
      {!pending && error == null && !matches.length && <p className={styles.empty}>{t(filter ? 'terminalNoMatches' : 'terminalNoSessions')}</p>}
    </div>
    <Stack gap="tight" paddingBlock="cozy" paddingInline="normal" className={styles.sidebarFooter}>
      <Heading as="h2" className={styles.footerTitle}>{t('terminal')}</Heading>
      <Button size="medium" variant="invisible" className={styles.newSession} alignContent="start" block leadingVisual={TerminalIcon}
        loading={opening} disabled={newDisabled} onClick={open}>{t('terminalNew')}</Button>
    </Stack>
  </Stack>
}
