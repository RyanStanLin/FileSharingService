import {useId, type RefObject} from 'react'
import {ActionList, ActionMenu, Button, IconButton, Stack, ToggleSwitch, UnderlineNav} from '@primer/react'
import {FileDirectoryIcon, GlobeIcon, GraphIcon, PlayIcon, TerminalIcon, ThreeBarsIcon, VersionsIcon} from '@primer/octicons-react'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {duration} from '../i18n/format'
import {Timestamp, timestampEpoch} from '../ui/Timestamp'
import {useAppearance} from './AppTheme'
import type {AppPage} from './useAppPage'
import styles from './shell.module.css'

interface Props {
  devices: Device[]
  device?: Device
  unlocked: boolean
  ready: boolean
  busy: boolean
  accessRef: RefObject<HTMLButtonElement | null>
  commandRef: RefObject<HTMLButtonElement | null>
  openQuick?: () => void
  select: (device: Device) => void
  toggle: (checked: boolean) => void
  shares?: () => void
  openPath?: () => void
  revoke: () => void
  page: AppPage
  filesHref: string
}

function DeviceMenu({devices, device, select, unlocked, shares, openPath, revoke}: Props) {
  const {t, locale, setLocale} = useLanguage()
  const {contrast, setContrast} = useAppearance()
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton size="medium" icon={ThreeBarsIcon} aria-label={t('deviceMenu')} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="start" width="medium">
        <ActionList>
          {unlocked && <ActionList.Group title={t('devices')} selectionVariant="single">
            {devices.length === 0 && <ActionList.Item disabled>{t('noDevices')}</ActionList.Item>}
            {devices.map(item => (
              <ActionList.Item key={item.id} selected={item.id === device?.id} onSelect={() => select(item)}>
                {item.name}
                <ActionList.Description variant="inline">{t(item.connection.online ? 'online' : 'offline')}</ActionList.Description>
              </ActionList.Item>
            ))}
          </ActionList.Group>}
          {unlocked && device?.connection.accessGranted && <>
            <ActionList.Divider />
            {openPath && <ActionList.Item onSelect={openPath} aria-keyshortcuts="Meta+Shift+G">
              {t('goTo')}…<ActionList.Description variant="inline">⌘⇧G</ActionList.Description>
            </ActionList.Item>}
            {shares && <ActionList.Item onSelect={shares}>{t('sharedFolders')}</ActionList.Item>}
            <ActionList.Item onSelect={revoke}>{t('connectionRevoke')}</ActionList.Item>
          </>}
          {unlocked && <ActionList.Divider />}
          <ActionList.Group title={t('appearance')} selectionVariant="single">
            <ActionList.Item selected={contrast === 'standard'} onSelect={() => setContrast('standard')}>
              {t('standardContrast')}
            </ActionList.Item>
            <ActionList.Item selected={contrast === 'high'} onSelect={() => setContrast('high')}>
              {t('highContrast')}
            </ActionList.Item>
          </ActionList.Group>
          <ActionList.Divider />
          <ActionList.Group title={t('language')} selectionVariant="single">
            <ActionList.Item selected={locale === 'en'} onSelect={() => setLocale('en')}>
              <ActionList.LeadingVisual><GlobeIcon /></ActionList.LeadingVisual>
              <span lang="en">English</span>
            </ActionList.Item>
            <ActionList.Item selected={locale === 'zh-CN'} onSelect={() => setLocale('zh-CN')}>
              <ActionList.LeadingVisual><GlobeIcon /></ActionList.LeadingVisual>
              <span lang="zh-CN">简体中文</span>
            </ActionList.Item>
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

export function Header(props: Props) {
  const {t, locale} = useLanguage()
  const access = useId()
  const {device} = props
  const connection = device?.connection
  const connectedAt = timestampEpoch(connection?.connectedAt) !== undefined ? connection?.connectedAt : undefined
  const onlineDuration = connectedAt ? <Timestamp value={connectedAt} variant="elapsed" />
    : connection?.connectionSeconds == null ? undefined : duration(connection.connectionSeconds, locale)
  return (
    <header className={styles.header}>
      <Stack direction="horizontal" align="center" gap={{narrow: "condensed", regular: "normal"}} padding={{narrow: "condensed", regular: "normal"}}>
        <DeviceMenu {...props} />
        <Stack.Item grow className={styles.context}>
          <Stack align="center" direction="horizontal" gap="condensed" className={styles.identity}>
            <span>{t('app')}</span>
            {device && <>
              <span aria-hidden="true" className={styles.slash}>/</span>
              <strong className={styles.deviceName} title={device.name}>{device.name}</strong>
              <span className={styles.deviceStatus}>
                <span aria-hidden="true" className={connection?.online ? styles.online : styles.offline} />
                {connection?.online ? onlineDuration ? <>{t('onlineFor')} {onlineDuration}</> : t('online') : t('offline')}
              </span>
            </>}
          </Stack>
        </Stack.Item>
        <Stack direction="horizontal" align="center" gap="condensed">
          <Button type="button" ref={props.commandRef} size="medium" className={styles.command} alignContent="start"
            disabled={!props.openQuick} onClick={props.openQuick} aria-haspopup="dialog" aria-label={t('command')}>
            <span className={styles.commandLabel}>{t('command')}</span>
            <span className={styles.commandGlyph}><TerminalIcon /></span>
          </Button>
          <span className={styles.divider} aria-hidden="true" />
          <span id={access}>{t('access')}</span>
          <ToggleSwitch ref={props.accessRef} size="medium" aria-labelledby={access} statusLabelPosition="start"
            buttonLabelOn={t('on')} buttonLabelOff={t('off')} loadingLabel={t('loading')}
            checked={props.unlocked} disabled={!props.ready} loading={props.busy} onChange={props.toggle} />
        </Stack>
      </Stack>
      <UnderlineNav aria-label={t('app')} className={styles.nav} hideIconsBreakpoint={null}>
        <UnderlineNav.Item href={props.filesHref} aria-current={props.page === 'files' ? 'page' : undefined}
          icon={FileDirectoryIcon}>{t('files')}</UnderlineNav.Item>
        <UnderlineNav.Item href={props.page === 'data' ? window.location.hash : '#data'} aria-current={props.page === 'data' ? 'page' : undefined}
          icon={GraphIcon}>{t('data')}</UnderlineNav.Item>
        <UnderlineNav.Item href="#activity" aria-current={props.page === 'activity' ? 'page' : undefined}
          icon={VersionsIcon}>{t('activity')}</UnderlineNav.Item>
        <UnderlineNav.Item href="#terminal" aria-current={props.page === 'terminal' ? 'page' : undefined}
          icon={TerminalIcon}>{t('terminal')}</UnderlineNav.Item>
        <UnderlineNav.Item href="#alerts" aria-current={props.page === 'alerts' ? 'page' : undefined}
          icon={PlayIcon}>{t('alerts')}</UnderlineNav.Item>
      </UnderlineNav>
    </header>
  )
}
