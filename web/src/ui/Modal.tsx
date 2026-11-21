import {Dialog, Heading, IconButton, Stack, type DialogHeaderProps, type DialogProps} from '@primer/react'
import {XIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'
import styles from './ui.module.css'

function Header({title, subtitle, dialogLabelId, dialogDescriptionId, onClose}: DialogHeaderProps) {
  const {t} = useLanguage()
  return (
    <Stack className={styles.dialogHeader} direction="horizontal" align="start" justify="space-between" gap="condensed" padding="normal">
      <Stack gap="tight">
        <Heading as="h2" id={dialogLabelId} className={styles.dialogTitle}>{title}</Heading>
        {subtitle && <p id={dialogDescriptionId} className={styles.caption}>{subtitle}</p>}
      </Stack>
      <IconButton size="medium" variant="invisible" icon={XIcon} aria-label={t('close')}
        onClick={() => onClose('close-button')} onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose('escape')
        }} />
    </Stack>
  )
}

export function Modal(props: DialogProps & {children: React.ReactNode}) {
  return <Dialog width="large" {...props} renderHeader={Header} />
}
