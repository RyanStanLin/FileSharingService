import {useEffect, useId, useRef, useState, type ReactNode} from 'react'
import {Button, Heading, NavList, SplitPageLayout, Stack, TextInput, useResponsiveValue} from '@primer/react'
import {ListUnorderedIcon, SearchIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import styles from './settings.module.css'

export interface SettingsNavGroup {
  label: string
  items: {label: string; href: string; current?: boolean; keywords?: string}[]
}

interface Props {
  title: string
  context?: string
  groups: SettingsNavGroup[]
  children: ReactNode
  storageKey: string
}

const sidebarWidth = {min: '184px', default: '231px', max: '432px'} as const

export function SettingsFrame({title, context, groups, children, storageKey}: Props) {
  const {t, locale} = useLanguage()
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const menu = useRef<HTMLButtonElement>(null)
  const heading = useId()
  const term = filter.trim().toLocaleLowerCase(locale)
  const visible = groups.map(group => ({
    ...group,
    items: group.items.filter(({label, keywords}) => [group.label, label, keywords].some(value =>
      value?.toLocaleLowerCase(locale).includes(term))),
  })).filter(group => group.items.length > 0)

  useEffect(() => { if (!narrow) setOpen(false) }, [narrow])

  const navigation = <>
    <Stack className={styles.sidebarHeader} gap="none" padding="normal">
      {!narrow && <Heading as="h2" id={heading} className={styles.sidebarTitle}>{title}</Heading>}
      {context && <div className={styles.sidebarContext}><div className={styles.caption} title={context}>{context}</div></div>}
      <TextInput size="medium" type="search" block leadingVisual={SearchIcon} aria-label={t('settingsSearch')}
        placeholder={t('settingsSearch')} value={filter} onChange={event => setFilter(event.target.value)} className={styles.search} />
    </Stack>
    <NavList className={styles.navigation} aria-label={title}>
      {visible.map((group, index) => <NavList.Group key={group.label} title={group.label} hideDivider={index === 0}>
        {group.items.map(item => <NavList.Item key={item.href} href={item.href}
          aria-current={item.current ? 'page' : undefined} onClick={() => setOpen(false)}>{item.label}</NavList.Item>)}
      </NavList.Group>)}
    </NavList>
    {!visible.length && <p className={styles.navEmpty} role="status">{t('settingsNoResults')}</p>}
  </>

  return <SplitPageLayout className={styles.workspace}>
    {!narrow && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarWidth}
      resizable widthStorageKey={storageKey} aria-labelledby={heading}>
      <div className={styles.sidebar}>{navigation}</div>
    </SplitPageLayout.Sidebar>}
    <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
      <Stack as="main" gap="none" className={styles.pane}>
        {narrow && <Stack padding="condensed" className={styles.mobileNavigation}>
          <Button size="medium" leadingVisual={ListUnorderedIcon} ref={menu} aria-haspopup="dialog" aria-expanded={open}
            onClick={() => setOpen(true)}>{title}</Button>
        </Stack>}
        {children}
      </Stack>
    </SplitPageLayout.Content>
    {narrow && open && <Modal title={title} onClose={() => setOpen(false)} returnFocusRef={menu}>
      {navigation}
    </Modal>}
  </SplitPageLayout>
}
