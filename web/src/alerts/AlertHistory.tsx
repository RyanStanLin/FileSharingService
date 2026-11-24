import {useId, useMemo, useState, type RefObject} from 'react'
import {Label, Radio} from '@primer/react'
import type {AlertSummary} from '../api/alerts'
import {useLanguage, type Message} from '../i18n'
import {ExplorerSortHeading} from '../ui/ExplorerSortHeading'
import {Timestamp, timestampEpoch} from '../ui/Timestamp'
import table from '../ui/explorerTable.module.css'
import styles from './alerts.module.css'

export const alertStatus: Record<AlertSummary['outcome'], Message> = {
  queued: 'alertSent', submitted: 'alertResponded', dismissed: 'alertDismissed', expired: 'alertExpired',
  cancelled: 'alertCancelled', failed: 'alertFailed',
}

const columns = {
  title: 'alertTitle', createdAt: 'alertSentColumn', recordedAt: 'alertRespondedColumn', outcome: 'alertStatus',
} satisfies Record<string, Message>
type Field = keyof typeof columns

export function AlertHistory({items, selected, select, focusedRadio}: {
  items: AlertSummary[]; selected?: string; select: (id: string) => void
  focusedRadio: RefObject<HTMLInputElement | null>
}) {
  const {t, locale} = useLanguage()
  const name = useId()
  const [sort, setSort] = useState<{field: Field; direction: 'asc' | 'desc'}>({field: 'recordedAt', direction: 'desc'})
  const rows = useMemo(() => {
    const text = new Intl.Collator(locale, {numeric: true})
    return [...items].sort((a, b) => {
      if (a.outcome === 'queued' || b.outcome === 'queued') return Number(b.outcome === 'queued') - Number(a.outcome === 'queued')
      const {field, direction} = sort
      const difference = field === 'createdAt' || field === 'recordedAt'
        ? (timestampEpoch(a[field]) ?? 0) - (timestampEpoch(b[field]) ?? 0)
        : text.compare(field === 'outcome' ? t(alertStatus[a.outcome]) : a.title ?? '',
            field === 'outcome' ? t(alertStatus[b.outcome]) : b.title ?? '')
      return direction === 'asc' ? difference : -difference
    })
  }, [items, locale, sort, t])

  return <table aria-label={t('alertHistory')} className={`${table.table} ${styles.historyTable}`}>
    <colgroup>
      <col className={table.iconColumn} />
      <col /><col /><col /><col />
    </colgroup>
    <thead><tr>
      <th scope="col" aria-label={t('alertInformation')} />
      {(Object.keys(columns) as Field[]).map(field => <ExplorerSortHeading key={field} field={field} label={t(columns[field])}
        sort={sort.field} direction={sort.direction} onSort={(field, direction) => setSort({field, direction})} />)}
    </tr></thead>
    <tbody>{rows.map(item => {
      const title = item.title ?? t('alertUnknownTitle')
      const checked = item.id === selected
      return <tr key={item.id} onClick={event => {
        if (event.target instanceof HTMLInputElement) return
        event.currentTarget.querySelector('input')?.focus()
        select(item.id)
      }}>
        <td className={table.checkCell}>
          <Radio ref={checked ? focusedRadio : undefined} name={name} value={item.id} checked={checked}
            aria-label={t('alertSelect', {title})} onChange={() => select(item.id)} />
        </td>
        <th scope="row" title={title}><span className={table.entryName}>{title}</span></th>
        <td><span className={table.cell}><Timestamp value={item.createdAt} /></span></td>
        <td><span className={table.cell}><Timestamp value={item.recordedAt} /></span></td>
        <td><Label variant={item.outcome === 'failed' ? 'danger' : 'default'}>{t(alertStatus[item.outcome])}</Label></td>
      </tr>
    })}</tbody>
  </table>
}
