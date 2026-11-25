import {Button} from '@primer/react'
import {ArrowLeftIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'

export function BackButton({to, destination}: {to: string; destination: string}) {
  const {t} = useLanguage()
  return <Button type="button" size="medium" leadingVisual={ArrowLeftIcon} aria-label={t('backTo', {destination})}
    onClick={() => { window.location.hash = to }}>{t('back')}</Button>
}
