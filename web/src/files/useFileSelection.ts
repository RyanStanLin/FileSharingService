import {useMemo, useRef, useState} from 'react'
import {ApiError} from '../api/client'
import {browse} from '../api/files'
import type {Device, Entry, Location} from '../api/types'
import type {Explorer} from './useExplorer'

interface Selection {
  all?: string
  paths: ReadonlySet<string>
}

const empty: Selection = {paths: new Set()}
const archiveLimit = 100

function contains(selection: Selection, path: string) {
  return selection.all ? !selection.paths.has(path) : selection.paths.has(path)
}

function withRange(selection: Selection, entries: Entry[], reverse = false): Selection {
  const paths = new Set(selection.paths)
  for (const {path} of entries) {
    if (reverse ? paths.has(path) : Boolean(selection.all)) paths.delete(path)
    else paths.add(path)
  }
  return {...selection, paths}
}

export function useFileSelection(device: Device, location: Location, {view, listing}: Explorer) {
  const [stored, setSelection] = useState<Selection>(empty)
  const anchor = useRef<string>(undefined)
  const current = useRef<string>(undefined)
  const {entries, page} = view
  const selected = stored.all && stored.all !== page?.revision ? empty : stored
  const positions = useMemo(() => new Map(entries.map((entry, index) => [entry.path, index])), [entries])
  const includes = (path: string) => contains(selected, path)
  const count = selected.all && page
    ? page.total - selected.paths.size
    : entries.filter(entry => selected.paths.has(entry.path)).length

  function clear() {
    anchor.current = undefined
    current.current = undefined
    setSelection(empty)
  }

  function selectAll() {
    if (!page?.total) return
    if (!current.current) current.current = entries[0]?.path
    if (!anchor.current) anchor.current = current.current
    setSelection({all: page.revision, paths: empty.paths})
  }

  function select(index: number, {toggle, extend}: {toggle?: boolean; extend?: boolean} = {}) {
    const entry = entries[index]
    if (!entry) return
    const start = anchor.current === undefined ? undefined : positions.get(anchor.current)
    current.current = entry.path
    if (extend && start !== undefined) {
      setSelection(withRange(toggle ? selected : empty, entries.slice(Math.min(index, start), Math.max(index, start) + 1)))
      return
    }
    anchor.current = entry.path
    setSelection(withRange(toggle ? selected : empty, [entry], toggle))
  }

  function moveFocus(step: number, extend: boolean, focusedRow?: number) {
    const previous = current.current === undefined ? undefined : positions.get(current.current)
    const index = focusedRow ?? previous
    if (extend && index !== undefined && anchor.current === undefined) anchor.current = entries[index]?.path
    const edge = step < 0 ? entries.length : -1
    const target = Math.max(0, Math.min(entries.length - 1, (index ?? edge) + step))
    select(target, {extend})
    return target
  }

  function marquee(baseline: Selection, first: number, last: number, mode: 'replace' | 'add' | 'toggle') {
    const matching = entries.slice(first, last + 1)
    setSelection(withRange(mode === 'replace' ? empty : baseline, matching, mode === 'toggle'))
  }

  function finishMarquee(index: number) {
    anchor.current = entries[index]?.path
    current.current = anchor.current
  }

  async function resolveEntries(signal: AbortSignal) {
    const result = entries.filter(entry => includes(entry.path))
    if (!selected.all || !page || result.length === count) return result
    let next = page
    while (next.nextOffset !== null && result.length < count) {
      next = await browse(device.id, location, listing, signal, next)
      result.push(...next.items.filter(entry => includes(entry.path)))
    }
    return result
  }

  async function downloadEntries(signal: AbortSignal) {
    if (count > archiveLimit) throw new ApiError(400, 'too_many_entries')
    return resolveEntries(signal)
  }

  return {selected, includes, count, clear, selectAll, select, moveFocus, marquee, finishMarquee, resolveEntries, downloadEntries,
    restore: setSelection, total: page?.total ?? 0, entries}
}

export type FileSelection = ReturnType<typeof useFileSelection>
