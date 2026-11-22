import {NavList} from '@primer/react'
import {useLanguage} from '../i18n'
import {categories, categoryKeys, dataHref, type Category} from './categories'
import styles from './dashboard.module.css'

export function DataSidebar({selected, close}: {selected: Category; close?: () => void}) {
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
      {categoryKeys.filter(key => key !== 'overview').map(item)}
    </NavList.Group>
  </NavList>
}
