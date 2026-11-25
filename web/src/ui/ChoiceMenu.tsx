import {useId} from 'react'
import {ActionList, ActionMenu, FormControl} from '@primer/react'
import {useLanguage} from '../i18n'

interface Props<Value extends string | number> {
  label: string
  value: Value
  options: readonly {value: Value; label: string}[]
  onChange: (value: Value) => void
  block?: boolean
  disabled?: boolean
  className?: string
  prefix?: string
}

export function ChoiceMenu<Value extends string | number>({label, value, options, onChange, block, disabled, className, prefix}: Props<Value>) {
  const {t} = useLanguage()
  const id = useId()
  const selected = options.find(option => option.value === value)
  const menu = <ActionMenu>
    <ActionMenu.Button id={id} size="medium" block={block} alignContent={block ? 'start' : undefined} labelWrap
      disabled={disabled} aria-label={selected ? t('choiceMenuLabel', {label, value: selected.label}) : label}>
      {prefix && selected ? prefix + ' ' : ''}{selected?.label ?? label}
    </ActionMenu.Button>
    <ActionMenu.Overlay align={block ? 'start' : 'end'} width="small" maxHeight="medium">
      <ActionList selectionVariant="single">
        {options.map(option => <ActionList.Item key={option.value} selected={option.value === value} disabled={disabled}
          onSelect={() => { if (option.value !== value) onChange(option.value) }}>
          {option.label}
        </ActionList.Item>)}
      </ActionList>
    </ActionMenu.Overlay>
  </ActionMenu>

  return block ? <FormControl id={id} disabled={disabled} className={className}>
    <FormControl.Label>{label}</FormControl.Label>
    {menu}
  </FormControl> : menu
}
