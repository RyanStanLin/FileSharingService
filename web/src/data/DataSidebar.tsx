import {NavList} from '@primer/react'
import {useLanguage} from '../i18n'
import {categories, categoryKeys, dataHref, logCategories, type Category} from './categories'
import {eventCategories, eventViews, type EventView} from './eventViews'
import styles from './dashboard.module.css'

export function DataSidebar({selected, eventView, close}: {selected: Category; eventView: EventView; close?: () => void}) {
  const {t} = useLanguage()

  function item(key: Category) {
    const {icon: Icon, label} = categories[key]
    return <NavList.Item key={key} href={dataHref(key)}
      aria-current={key === selected ? 'page' : undefined} onClick={close}>
      <NavList.LeadingVisual><Icon /></NavList.LeadingVisual>
      {t(label)}
    </NavList.Item>
  }

  return <NavList className={styles.navigation}>
    <NavList.Heading visuallyHidden>{t('dataCategories')}</NavList.Heading>
    {item('overview')}
    <NavList.Group title={t('dataCategories')} hideDivider>
      {categoryKeys.filter(key => key !== 'overview' && key !== 'events' && key !== 'deliveries' && key !== 'audit').map(item)}
    </NavList.Group>
    <NavList.Group title={t('dataEventGroup')} hideDivider>
      {eventViews.map(view => {
        const {icon: Icon, label} = eventCategories[view]
        return <NavList.Item key={view} href={dataHref('events', {view: view === 'all' ? undefined : view})}
          aria-current={selected === 'events' && eventView === view ? 'page' : undefined} onClick={close}>
          <NavList.LeadingVisual><Icon /></NavList.LeadingVisual>
          {t(label)}
        </NavList.Item>
      })}
    </NavList.Group>
    <NavList.Group title={t('notificationLogs')} hideDivider>{logCategories.map(item)}</NavList.Group>
  </NavList>
}
