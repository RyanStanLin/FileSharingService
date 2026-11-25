import {useEffect, useId, useRef, useState, type ReactNode} from 'react'
import {Button, SplitPageLayout, Stack, useResponsiveValue} from '@primer/react'
import {ListUnorderedIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {DataSidebar} from './DataSidebar'
import type {Category} from './categories'
import type {EventView} from './eventViews'
import styles from './dashboard.module.css'

const sidebarWidth = {min: '176px', default: '272px', max: '480px'} as const

export function DataFrame({heading, category, eventView, children}: {
  heading?: string; category: Category; eventView: EventView; children: ReactNode
}) {
  const {t} = useLanguage()
  const sidebarId = useId()
  const menu = useRef<HTMLButtonElement>(null)
  const [showNavigation, setShowNavigation] = useState(false)
  const narrow = useResponsiveValue({narrow: true, regular: false, wide: false}, false)

  useEffect(() => { if (!narrow) setShowNavigation(false) }, [narrow])

  return <>
    <SplitPageLayout className={styles.workspace}>
      {!narrow && <SplitPageLayout.Sidebar padding="none" divider="line" width={sidebarWidth}
        resizable widthStorageKey="filesharing.data-sidebar-width" aria-label={t('dataCategories')}>
        <div className={styles.sidebar}><DataSidebar selected={category} eventView={eventView} /></div>
      </SplitPageLayout.Sidebar>}
      <SplitPageLayout.Content width="full" padding="none" className={styles.content}>
        <Stack as="main" aria-labelledby={heading} className={styles.pane} gap="none">
          {narrow && <div className={styles.mobileNavigation}>
            <Button ref={menu} size="medium" leadingVisual={ListUnorderedIcon} aria-haspopup="dialog" aria-expanded={showNavigation}
              aria-controls={sidebarId} onClick={() => setShowNavigation(true)}>{t('dataCategories')}</Button>
          </div>}
          {children}
        </Stack>
      </SplitPageLayout.Content>
    </SplitPageLayout>
    {narrow && showNavigation && <Modal title={t('dataCategories')} onClose={() => setShowNavigation(false)} returnFocusRef={menu}>
      <div id={sidebarId}><DataSidebar selected={category} eventView={eventView} close={() => setShowNavigation(false)} /></div>
    </Modal>}
  </>
}
