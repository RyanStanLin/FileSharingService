import {useState, type ComponentProps} from 'react'
import {Button, SelectPanel} from '@primer/react'
import {TriangleDownIcon} from '@primer/octicons-react'
import {useLanguage} from '../i18n'

export interface MultiChoiceOption {
  id: string
  text: string
  description?: string
  groupId?: string
}

type PanelItem = ComponentProps<typeof SelectPanel>['items'][number]

export function SettingsMultiChoice({label, value, items, groups, change, max, disabled}: {
  label: string; value: string[]; items: MultiChoiceOption[]; groups?: {groupId: string; header: string}[]
  change: (value: string[]) => void; max: number; disabled?: boolean
}) {
  const {t, locale} = useLanguage()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const selected = items.filter(item => value.includes(item.id))
  const term = filter.trim().toLocaleLowerCase(locale)
  const visible = items.filter(item => [item.text, item.id, item.description].some(text =>
    text?.toLocaleLowerCase(locale).includes(term))).map(item => ({
    ...item, disabled: value.length >= max && !value.includes(item.id),
  }))
  return <SelectPanel title={label} subtitle={t('notificationSelectionRange', {max})}
    placeholderText={t('settingsSearch')} inputLabel={t('settingsSearch')} open={open} width="large"
    onOpenChange={next => { setOpen(next); if (!next) setFilter('') }} selected={selected} filterValue={filter} items={visible}
    onFilterChange={setFilter} onSelectedChange={(options: PanelItem[]) => change(options.map(option => String(option.id)))}
    {...(groups ? {groupMetadata: groups.filter(group => visible.some(item => item.groupId === group.groupId))
      .map(group => ({...group, header: {title: group.header}}))} : {})}
    renderAnchor={({children: _children, ...anchor}) => <Button {...anchor} trailingAction={TriangleDownIcon} size="medium"
      disabled={disabled} aria-haspopup="dialog" aria-label={label}>
      {value.length > 0 ? t('notificationSelected', {count: value.length}) : label}
    </Button>}
    message={visible.length === 0 ? {title: t('settingsNoResults'), variant: 'empty', body: ''} : undefined} />
}
