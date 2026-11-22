import {useState, type ReactNode} from 'react'
import {Button, ButtonGroup, Stack} from '@primer/react'
import type {DataObject} from '../api/telemetry'
import {useLanguage} from '../i18n'
import {Modal} from '../ui/Modal'
import {DataFacts} from './DataFacts'
import styles from './details.module.css'

const pageSize = 20

export function useRecordPage<T>(rows: T[]) {
  const [requested, setPage] = useState(1)
  const total = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = Math.min(total, requested)
  return {rows: rows.slice((page - 1) * pageSize, page * pageSize), page, total, setPage}
}

export function RecordPager({page, total, setPage}: {page: number; total: number; setPage: (page: number) => void}) {
  const {t} = useLanguage()
  if (total < 2) return null
  return <Stack direction="horizontal" align="center" justify="space-between" gap="condensed" wrap="wrap">
    <span className={styles.muted}>{t('dataPage', {page, total})}</span>
    <ButtonGroup>
      <Button size="medium" disabled={page === 1} onClick={() => setPage(page - 1)}>{t('dataPrevious')}</Button>
      <Button size="medium" disabled={page === total} onClick={() => setPage(page + 1)}>{t('dataNext')}</Button>
    </ButtonGroup>
  </Stack>
}

export function RecordDialog({title, value, close, children}: {
  title: string
  value: DataObject
  close: () => void
  children?: ReactNode
}) {
  const {t} = useLanguage()
  return <Modal title={title} onClose={close} footerButtons={[{size: 'medium', content: t('close'), onClick: close}]}>
    <Stack gap="normal">
      <DataFacts value={value} />
      {children}
    </Stack>
  </Modal>
}
