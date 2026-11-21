import {Breadcrumbs} from '@primer/react'
import type {Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {href} from './navigation'
import styles from './workspace.module.css'

export function PathBar({location, share}: {location: Location; share: Share}) {
  const {t} = useLanguage()
  const segments = location.path ? location.path.split('/') : []
  const path = [share.primary ? t('userFolder') : share.label, ...segments]
  return (
    <div className={styles.pathBar}>
      <Breadcrumbs aria-label={t('path')}>
        {path.map((name, index) => {
          const selected = index === path.length - 1
          const target = {...location, path: segments.slice(0, index).join('/'), kind: selected ? location.kind : 'folder'} as const
          return <Breadcrumbs.Item key={target.path} selected={selected} href={href(target)}>{name}</Breadcrumbs.Item>
        })}
      </Breadcrumbs>
    </div>
  )
}
