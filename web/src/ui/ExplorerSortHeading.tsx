import {Button} from '@primer/react'
import {SortAscIcon, SortDescIcon} from '@primer/octicons-react'
import styles from './explorerTable.module.css'

export function ExplorerSortHeading<Key extends string>({field, label, sort, direction, onSort}: {
  field: Key
  label: string
  sort: Key
  direction: 'asc' | 'desc'
  onSort: (field: Key, direction: 'asc' | 'desc') => void
}) {
  const current = field === sort
  const ascending = direction === 'asc'
  return <th scope="col" aria-sort={current ? ascending ? 'ascending' : 'descending' : undefined}>
    <Button size="small" variant="invisible" block alignContent="start" className={styles.sortButton}
      title={label} trailingVisual={current ? ascending ? SortAscIcon : SortDescIcon : undefined}
      onClick={() => onSort(field, current && ascending ? 'desc' : 'asc')}>
      <span className={styles.cell}>{label}</span>
    </Button>
  </th>
}
