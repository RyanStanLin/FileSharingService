import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {Stack} from '@primer/react'
import {useLanguage} from '../i18n'
import {date} from '../i18n/format'
import {ExplorerFacts, ExplorerHeader, ExplorerTitle} from '../ui/ExplorerHeader'
import {Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTableEnd} from '../ui/useTableEnd'
import styles from '../ui/explorer.module.css'
import {ReadingTable} from './ReadingTable'
import {decimal} from './format'
import {objectDataset, sortRows, type ReadingDataset, type ReadingRow} from './readingModel'

export interface ReadingChrome {
  heading: string
  deviceName: string
  stream: string
  offline: boolean
  pending: boolean
  action: ReactNode
  notices: ReactNode
}

interface Props {
  chrome: ReadingChrome
  dataset: ReadingDataset
  controls?: ReactNode
  filter?: string
  rowAction?: (row: ReadingRow) => ReactNode
}

const pageSize = 80

export function ReadingPane({chrome, dataset, controls, ...table}: Props) {
  const {t, locale} = useLanguage()
  const observedAt = dataset.snapshot?.observedAt
  const outdated = dataset.snapshot?.stale && !chrome.offline
  return <>
    <ExplorerHeader title={<ExplorerTitle id={chrome.heading} title={dataset.title}
      detail={[t('dataOnDevice', {name: chrome.deviceName}), dataset.description].filter(Boolean).join(' · ')} />}
      facts={<ExplorerFacts items={[
        ['dataListCount', decimal(dataset.rows.length, locale)],
        ['dataUpdated', observedAt ? <time dateTime={observedAt}>{date(observedAt, locale)}</time> : t('missing')],
        ['dataStatus', <span role="status">{outdated ? t('dataStale') : chrome.stream}</span>],
      ]} />}
      actions={<Stack direction="horizontal" align="end" wrap="wrap" gap="condensed">
        {controls}
        {chrome.action}
      </Stack>} />
    <TableViewport key={dataset.key} {...table} dataset={dataset} chrome={chrome} />
  </>
}

function TableViewport({chrome, dataset, filter, rowAction}: Props) {
  const {t, locale} = useLanguage()
  const scroll = useRef<HTMLDivElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<ReadingRow>()
  const [limit, setLimit] = useState(pageSize)
  const [sort, setSort] = useState<NonNullable<ReadingDataset['sort']>>(dataset.sort ?? {key: 'name', direction: 'asc'})
  const collator = useMemo(() => new Intl.Collator(locale, {numeric: true, sensitivity: 'base'}), [locale])
  const rows = useMemo(() => sortRows(dataset.rows, sort.key, sort.direction, collator), [dataset.rows, sort, collator])
  const more = rows.length > limit
  const tail = useTableEnd(more ? limit : undefined, () => setLimit(value => value + pageSize), scroll)
  const pending = (chrome.pending || dataset.pending) && !rows.length
  const active = selected && (dataset.rows.find(row => row.id === selected.id) ?? selected)

  useEffect(() => {
    setLimit(pageSize)
    scroll.current?.scrollTo(0, 0)
  }, [filter, sort])

  return <Stack ref={scroll} gap="none" className={styles.body} aria-busy={pending}>
    {chrome.notices}
    <div ref={region} className={styles.tableScroll} tabIndex={0} role="region" aria-label={dataset.title}>
      <ReadingTable headingId={chrome.heading} nameTitle={dataset.nameTitle} columns={dataset.columns}
        rows={rows.slice(0, limit)} icons={dataset.icons} current={selected?.id} sort={sort}
        onSort={(key, direction) => setSort({key, direction})} open={dataset.details ? setSelected : undefined} />
    </div>
    {pending ? <Loading /> : !rows.length && <p className={styles.empty}>{dataset.empty ?? t('dataNoSample')}</p>}
    {more && <span className={styles.pageEnd} ref={tail} aria-hidden="true" />}
    {active?.value && <ReadingDialog row={active} action={rowAction?.(active)} close={() => setSelected(undefined)}
      region={region} restoreToRegion={!rows.slice(0, limit).some(row => row.id === active.id)} />}
  </Stack>
}

function ReadingDialog({row, action, close, region, restoreToRegion}: {
  row: ReadingRow
  action?: ReactNode
  close: () => void
  region: React.RefObject<HTMLDivElement | null>
  restoreToRegion: boolean
}) {
  const {t, locale} = useLanguage()
  const dataset = objectDataset(row.id, row.name.text, row.value, locale, t)
  return <Modal title={row.name.text} onClose={close} returnFocusRef={restoreToRegion ? region : undefined}
    footerButtons={[{size: 'medium', content: t('close'), onClick: close}]}>
    <Stack gap="normal">
      <ReadingTable nameTitle={dataset.nameTitle} columns={dataset.columns} rows={dataset.rows} dialog />
      {action}
    </Stack>
  </Modal>
}
