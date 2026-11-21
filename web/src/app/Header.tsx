import {useId, type RefObject} from 'react'
import {ActionList, ActionMenu, IconButton, Stack, TextInput, ToggleSwitch, UnderlineNav} from '@primer/react'
import {FileDirectoryIcon, GlobeIcon, GraphIcon, TerminalIcon, ThreeBarsIcon, VersionsIcon} from '@primer/octicons-react'
import type {Device} from '../api/types'
import {useLanguage} from '../i18n'
import {duration} from '../i18n/format'
import styles from './shell.module.css'

interface Props {
  devices: Device[]
  device?: Device
  unlocked: boolean
  ready: boolean
  busy: boolean
  accessRef: RefObject<HTMLButtonElement | null>
  select: (device: Device) => void
  toggle: (checked: boolean) => void
  shares: () => void
  revoke: () => void
}

function DeviceMenu({devices, device, select, unlocked, shares, revoke}: Props) {
  const {t, locale, setLocale} = useLanguage()
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
            <ActionList.Item onSelect={shares}>{t('sharedFolders')}</ActionList.Item>
            <ActionList.Item onSelect={revoke}>{t('connectionRevoke')}</ActionList.Item>
          </>}
          {unlocked && <ActionList.Divider />}
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
                {connection?.online
                  ? connection.connectionSeconds === null ? t('online') : t('onlineFor', {duration: duration(connection.connectionSeconds, locale)})
                  : t('offline')}
              </span>
            </>}
          </Stack>
        </Stack.Item>
        <Stack direction="horizontal" align="center" gap="condensed">
          <TextInput size="medium" disabled className={styles.command} trailingVisual={TerminalIcon}
            aria-label={t('command')} placeholder={t('command')} />
          <span className={styles.divider} aria-hidden="true" />
          <span id={access}>{t('access')}</span>
          <ToggleSwitch ref={props.accessRef} size="medium" aria-labelledby={access} statusLabelPosition="start"
            buttonLabelOn={t('on')} buttonLabelOff={t('off')} loadingLabel={t('loading')}
            checked={props.unlocked} disabled={!props.ready} loading={props.busy} onChange={props.toggle} />
        </Stack>
      </Stack>
      <UnderlineNav aria-label={t('files')} className={styles.nav} hideIconsBreakpoint={null}>
        <UnderlineNav.Item href={window.location.hash || '#files'} aria-current="page" icon={FileDirectoryIcon}>{t('files')}</UnderlineNav.Item>
        <UnderlineNav.Item as="span" className={styles.inactiveTab} aria-disabled="true" icon={GraphIcon}>{t('data')}</UnderlineNav.Item>
        <UnderlineNav.Item as="span" className={styles.inactiveTab} aria-disabled="true" icon={VersionsIcon}>{t('activity')}</UnderlineNav.Item>
      </UnderlineNav>
    </header>
  )
}
