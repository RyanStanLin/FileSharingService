import {ActionList, ActionMenu, IconButton, Label, Link} from '@primer/react'
import {InfoIcon, KebabHorizontalIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'
import {ExplorerSortHeading} from '../ui/ExplorerSortHeading'
import {Timestamp} from '../ui/Timestamp'
import styles from '../ui/explorerTable.module.css'
import type {ReadingCell, ReadingColumn, ReadingRow} from './readingModel'

interface TableProps {
  headingId?: string
  nameTitle: string
  columns: ReadingColumn[]
  rows: ReadingRow[]
  icons?: boolean
  current?: string
  sort?: {key: string; direction: 'asc' | 'desc'}
  onSort?: (key: string, direction: 'asc' | 'desc') => void
  arrivals?: {ids?: ReadonlySet<string>; finish: (id: string) => void}
  open?: (row: ReadingRow) => void
  dialog?: boolean
  exactTimes?: boolean
}

function CellValue({value, exactTimes}: {value: ReadingCell; exactTimes: boolean}) {
  if (value.datetime) return <Timestamp value={value.datetime} variant={value.elapsed ? 'elapsed' : exactTimes ? 'exact' : 'recent'} />
  return value.label ? <Label>{value.text}</Label> : value.text
}

export function ReadingTable({headingId, nameTitle, columns, rows, icons, current, sort, onSort, arrivals, open, dialog, exactTimes}: TableProps) {
  const {t} = useLanguage()
  const fields = [{key: 'name', title: nameTitle}, ...columns]
  const precise = Boolean(dialog || exactTimes)
  return <table aria-labelledby={headingId} aria-label={headingId ? undefined : t('viewInfo')} data-event-table={arrivals ? '' : undefined}
    className={dialog ? `${styles.table} ${styles.dialogTable}` : styles.table}>
    <colgroup>
      {icons && <col className={styles.iconColumn} />}
      {fields.map(field => <col key={field.key} />)}
      {open && <col className={styles.menuColumn} />}
    </colgroup>
    <thead><tr>
      {icons && <th scope="col" aria-hidden="true" />}
      {fields.map(field => sort && onSort
        ? <ExplorerSortHeading key={field.key} field={field.key} label={field.title} sort={sort.key} direction={sort.direction} onSort={onSort} />
        : <th scope="col" key={field.key} className={styles.plainHeading}>{field.title}</th>)}
      {open && <th scope="col" aria-label={t('filesMenu')} />}
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.id} data-data-row="" data-selected={row.id === current}
      data-event-arrival={arrivals?.ids?.has(row.id) ? '' : undefined}
      onAnimationEnd={arrivals && (event => { if (event.target === event.currentTarget) arrivals.finish(row.id) })}>
      {icons && <td className={styles.iconCell} aria-hidden="true">{row.icon}</td>}
      <th scope="row" title={row.name.datetime ? undefined : row.name.text}>
        {open && row.value
          ? <Link as="button" type="button" className={`${styles.entryName} ${styles.rowLink}`} onClick={() => open(row)}>{row.name.text}</Link>
          : <span className={row.name.datetime ? `${styles.entryName} ${styles.timeCell}` : styles.entryName}>
            <CellValue value={row.name} exactTimes={precise} />
          </span>}
      </th>
      {columns.map(({key}) => {
        const value = row.values[key]
        const modifier = value?.preview ? styles.previewCell : value?.datetime ? styles.timeCell : undefined
        return <td key={key} title={modifier ? undefined : value?.text}>
          <span className={modifier ? `${styles.cell} ${modifier}` : styles.cell}>
            {value ? <CellValue value={value} exactTimes={precise} /> : t('missing')}
          </span>
        </td>
      })}
      {open && <td className={styles.menuCell}>{row.value && <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton icon={KebabHorizontalIcon} variant="invisible" size="medium" aria-label={t('actions', {name: row.name.text})} />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay align="end" width="small">
          <ActionList>
            <ActionList.Item onSelect={() => open(row)}>
              <ActionList.LeadingVisual><InfoIcon /></ActionList.LeadingVisual>{t('viewInfo')}
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>}</td>}
    </tr>)}</tbody>
  </table>
}
