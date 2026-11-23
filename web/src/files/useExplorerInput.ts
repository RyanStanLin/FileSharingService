import {useEffect, useRef, type KeyboardEvent, type MouseEvent} from 'react'
import type {Entry, Location} from '../api/types'
import {explorerControl, primaryModifier} from './explorerInput'
import {locationOf, navigate, parent} from './navigation'
import type {FileSelection} from './useFileSelection'

const doubleClickWindow = 500
const doubleClickTravel = 5

export function useExplorerInput(location: Location, selection: FileSelection, loadNext: () => void,
  clipboard: {copy?: () => void; paste?: () => void}) {
  const commands = useRef({selectAll: selection.selectAll, ...clipboard})
  const lastClick = useRef<{entry: Entry; x: number; y: number; time: number; newlySelected: boolean}>(undefined)
  useEffect(() => { commands.current = {selectAll: selection.selectAll, ...clipboard} }, [selection.selectAll, clipboard])
  useEffect(() => {
    function onShortcut(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || !primaryModifier(event) || event.shiftKey || event.altKey ||
        document.querySelector('[aria-modal="true"]')) return
      const key = event.key.toLowerCase()
      if (key === 'a' && event.target === document.body) {
        event.preventDefault()
        commands.current.selectAll()
        return
      }
      const action = key === 'c' ? commands.current.copy : key === 'v' ? commands.current.paste : undefined
      if (!action || event.repeat || !(event.target instanceof Element) ||
        event.target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="menu"]') ||
        (key === 'c' && document.getSelection()?.isCollapsed === false)) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  function rowEvent(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || !event.detail || !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) || explorerControl(event.target) || event.target.closest('thead')) return
    return event.target.closest<HTMLTableRowElement>('[data-file-row]') ?? null
  }

  function onClick(event: MouseEvent<HTMLElement>) {
    const row = rowEvent(event)
    if (row === undefined) return
    if (event.target instanceof Element && event.target.closest('[data-file-link]') &&
      (event.nativeEvent as PointerEvent).pointerType === 'touch') return
    event.preventDefault()
    event.currentTarget.focus({preventScroll: true})
    if (row) {
      const entry = selection.entries[row.sectionRowIndex]
      if (entry && !event.shiftKey && !primaryModifier(event)) {
        lastClick.current = {entry, x: event.clientX, y: event.clientY, time: performance.now(), newlySelected: !selection.count}
      } else lastClick.current = undefined
      selection.select(row.sectionRowIndex, {toggle: primaryModifier(event), extend: event.shiftKey})
    } else if (!primaryModifier(event) && !event.shiftKey) {
      lastClick.current = undefined
      selection.clear()
    }
  }

  function onGroupClick(event: MouseEvent<HTMLElement>) {
    const click = lastClick.current
    if (!click || !event.detail || event.shiftKey || primaryModifier(event) || !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) || Math.hypot(event.clientX - click.x, event.clientY - click.y) > doubleClickTravel ||
      performance.now() - click.time > doubleClickWindow || (event.detail < 2 && !click.newlySelected)) return
    if (!selection.entries.some(entry => entry.path === click.entry.path)) return
    lastClick.current = undefined
    event.preventDefault()
    event.stopPropagation()
    navigate(locationOf(location.rootId, click.entry))
  }

  function open(index: number) {
    const entry = selection.entries[index]
    if (entry) navigate(locationOf(location.rootId, entry))
  }

  function onDoubleClick(event: MouseEvent<HTMLElement>) {
    if (event.shiftKey || primaryModifier(event)) return
    const row = rowEvent(event)
    if (row) open(row.sectionRowIndex)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const {target, currentTarget: canvas, key} = event
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || !(target instanceof Element) ||
      !canvas.contains(target) || explorerControl(target)) return
    const primary = primaryModifier(event)
    if (primary && !event.shiftKey) {
      if (key.toLowerCase() === 'a') {
        event.preventDefault()
        selection.selectAll()
      } else if ((key.toLowerCase() === 'o' || key === 'ArrowDown') && selection.count === 1) {
        const index = selection.entries.findIndex(entry => selection.includes(entry.path))
        if (index !== -1) {
          event.preventDefault()
          open(index)
        }
      } else if (key === 'ArrowUp' && location.path) {
        event.preventDefault()
        navigate({...location, path: parent(location.path)})
      }
      return
    }
    if (key === 'Escape' && selection.count) {
      event.preventDefault()
      selection.clear()
    }
    if (key !== 'ArrowUp' && key !== 'ArrowDown' || !selection.entries.length || primary) return
    event.preventDefault()
    const focusedRow = target.closest<HTMLTableRowElement>('[data-file-row]')?.sectionRowIndex
    const index = selection.moveFocus(key === 'ArrowUp' ? -1 : 1, event.shiftKey, focusedRow)
    const row = canvas.querySelector('tbody')?.rows[index]
    row?.querySelector<HTMLElement>('[data-file-link]')?.focus({preventScroll: true})
    row?.scrollIntoView({block: 'nearest', inline: 'nearest'})
    if (key === 'ArrowDown' && index === selection.entries.length - 1) loadNext()
  }

  return {onClick, onDoubleClick, onKeyDown, onGroupClick}
}
