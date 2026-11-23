import {useEffect, useRef, useState} from 'react'
import {ApiError} from '../api/client'
import {move} from '../api/files'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {number} from '../i18n/format'
import {useTask} from '../ui/async'
import type {EntrySource} from './actions'
import {isVersionMismatch} from './fileName'
import {canWriteEntry, canWriteFolder, join} from './navigation'

interface StagedMove {
  source: Location
  entries: Entry[]
}

interface MoveResult {
  moved: number
  failed?: string
}

export function useMoveClipboard(device: string, shares: Share[], refresh: () => void) {
  const {t, locale, errorText} = useLanguage()
  const [staged, setStaged] = useState<StagedMove>()
  const [result, setResult] = useState<MoveResult>()
  const task = useTask()
  const refreshCurrent = useRef(refresh)

  useEffect(() => { refreshCurrent.current = refresh }, [refresh])
  useEffect(() => {
    if (!result?.moved || result.failed) return
    const timer = window.setTimeout(() => setResult(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [result])

  function canMoveSource(source: Location, entries: Entry[]) {
    const share = shares.find(item => item.id === source.rootId)
    return share && entries.every(entry => canWriteEntry(share, entry.path))
  }

  function copy(source: Location, read: EntrySource) {
    void task.run(async signal => {
      setStaged(undefined)
      setResult(undefined)
      const entries = typeof read === 'function' ? await read(signal) : read
      if (signal.aborted || !entries.length) return
      if (!canMoveSource(source, entries)) throw new ApiError(403, 'move_source_read_only')
      setStaged({source, entries})
    })
  }

  function destinationIssue(target: Location, batch: StagedMove) {
    const share = shares.find(item => item.id === target.rootId)
    if (!share || !canWriteFolder(share, target.path)) return 'read_only'
    if (!canMoveSource(batch.source, batch.entries)) return 'move_source_read_only'
    if (batch.source.rootId !== target.rootId) return
    if (batch.source.path === target.path) return 'move_same_folder'
    if (batch.entries.some(entry => target.path === entry.path || target.path.startsWith(entry.path + '/'))) {
      return 'invalid_destination'
    }
  }

  function paste(target: Location) {
    if (!staged) return
    const batch = staged
    void task.run(async signal => {
      setResult(undefined)
      const issue = destinationIssue(target, batch)
      if (issue) throw new ApiError(400, issue)
      let moved = 0
      let failed: string | undefined
      try {
        for (const entry of batch.entries) {
          if (signal.aborted) return
          await move(device, batch.source, entry, join(target.path, entry.name), target.rootId, signal)
          moved++
        }
      } catch (error) {
        failed = batch.entries[moved]?.name
        throw isVersionMismatch(error) ? new ApiError(409, 'move_source_changed') : error
      } finally {
        if (!signal.aborted) {
          const remaining = batch.entries.slice(moved)
          setStaged(remaining.length ? {...batch, entries: remaining} : undefined)
          setResult({moved, failed})
          refreshCurrent.current()
        }
      }
    })
  }

  const status = task.busy ? t(staged ? 'filePasteMoving' : 'fileCopyPreparing')
    : result?.moved ? t('filesMoved', {count: number(result.moved, locale)})
      : staged ? t('filesCopiedForMove', {count: number(staged.entries.length, locale)}) : undefined
  const error = task.error ? (result?.failed
    ? t('filePasteFailed', {name: result.failed, error: errorText(task.error)}) : errorText(task.error)) : undefined

  return {
    copy, paste, busy: task.busy, hasItems: Boolean(staged), status, error,
    canPaste: (target: Location) => !task.busy && !!staged && !destinationIssue(target, staged),
  }
}

export type MoveClipboard = ReturnType<typeof useMoveClipboard>
