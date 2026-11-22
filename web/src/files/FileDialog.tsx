import {useId, useState} from 'react'
import {Button, Checkbox, FormControl, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {move, remove, stat, trash} from '../api/files'
import type {Location} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource, useTask} from '../ui/async'
import type {FileAction, FileDialogProps} from './actions'
import {isStaleEntry, isVersionMismatch} from './fileName'
import {Metadata} from './Metadata'
import {MovePicker} from './MovePicker'
import {NameMutationDialog} from './NameMutationDialog'
import {canWriteEntry, canWriteFolder, join, parent} from './navigation'

type InfoAction = Extract<FileAction, {kind: 'info'}>
type MoveAction = Extract<FileAction, {kind: 'move'}>
type RemoveAction = Extract<FileAction, {kind: 'trash' | 'remove'}>

function InfoDialog({action, location, deviceId, close}: FileDialogProps<InfoAction>) {
  const {t} = useLanguage()
  const [calculate, setCalculate] = useState(false)
  const target = action.entry ? {...location, path: action.entry.path} : location
  const key = JSON.stringify([target.rootId, target.path])
  const info = useResource(key, signal => stat(deviceId, target, signal))
  const totals = useResource(calculate ? key : null, signal => stat(deviceId, target, signal, true))
  const entry = totals.data ?? info.data

  return (
    <Modal title={t('fileInfo')} onClose={close} footerButtons={[{size: 'medium', content: t('close'), onClick: close}]}>
      <Stack gap="condensed">
        {info.pending && !entry && <Loading />}
        <ErrorText error={info.error} />
        {entry && <><strong>{entry.name}</strong><Metadata entry={entry} all /></>}
        {entry?.kind === 'directory' && !totals.data && <Stack align="start" gap="condensed">
          <Button size="medium" loading={totals.pending} loadingAnnouncement={t('readingFolderTotals')} onClick={() =>
            calculate ? totals.refresh() : setCalculate(true)}>
            {t('readFolderTotals')}
          </Button>
          <ErrorText error={totals.error} />
        </Stack>}
      </Stack>
    </Modal>
  )
}

function MoveDialog({action, deviceId, location, roots, share, hidden, close, changed, refresh}: FileDialogProps<MoveAction>) {
  const {t} = useLanguage()
  const form = useId()
  const task = useTask()
  const entry = action.entry
  const origin = parent(entry.path)
  const [target, setTarget] = useState<Location>({...location, path: origin, kind: 'folder'})
  const [submitted, setSubmitted] = useState<Location>()
  const allowedTargets = roots.filter(root => root.writable || root.writableFolders?.length)
  const targetShare = allowedTargets.find(root => root.id === target.rootId)
  const sameRoot = target.rootId === share.id
  const issue = !targetShare || !canWriteFolder(targetShare, target.path) ? 'moveReadOnly'
    : sameRoot && target.path === origin ? 'moveDifferentFolder'
    : sameRoot && (target.path === entry.path || target.path.startsWith(entry.path + '/')) ? 'moveInsideSource'
    : undefined
  const sourceWritable = canWriteEntry(share, entry.path)
  const sourceChanged = isVersionMismatch(task.error)

  return <Modal title={t('moveEntry', {name: entry.name})} onClose={() => { if (!task.busy) close() }} footerButtons={[
    {size: 'medium', content: t('cancel'), onClick: close, disabled: task.busy},
    {size: 'medium', content: t('moveHere'), type: 'submit', form, buttonType: 'primary',
      loading: task.busy, disabled: Boolean(issue) || !sourceWritable || sourceChanged},
  ]}>
    <Stack as="form" id={form} gap="normal" onSubmit={(event: React.FormEvent) => {
      event.preventDefault()
      if (issue || task.busy || !sourceWritable || sourceChanged) return
      setSubmitted(target)
      void task.run(async signal => {
        try {
          const result = await move(deviceId, location, entry, join(target.path, entry.name), target.rootId, signal)
          if (!signal.aborted) changed(result)
        } catch (error) {
          if (isStaleEntry(error)) refresh()
          throw error
        }
      })
    }}>
      {!sourceWritable && <ErrorText error={new ApiError(403, 'root_access_denied')} />}
      <MovePicker device={deviceId} roots={allowedTargets} source={location} entry={entry}
        target={target} hidden={hidden} onTarget={setTarget} busy={task.busy} />
      {issue && <FormControl.Caption>{t(issue)}</FormControl.Caption>}
      {sourceChanged ? <ErrorText error={new ApiError(409, 'mutation_source_changed')} />
        : submitted === target && <ErrorText error={task.error} />}
    </Stack>
  </Modal>
}

function RemoveDialog({action, deviceId, location, share, close, changed, refresh}: FileDialogProps<RemoveAction>) {
  const {t} = useLanguage()
  const form = useId()
  const task = useTask()
  const [recursive, setRecursive] = useState(false)
  const writable = canWriteEntry(share, action.entry.path)
  const sendingToTrash = action.kind === 'trash'

  return <Modal title={t(sendingToTrash ? 'trashEntry' : 'deleteEntry', {name: action.entry.name})} role="alertdialog"
    onClose={() => { if (!task.busy) close() }} footerButtons={[
      {size: 'medium', content: t('cancel'), onClick: close, disabled: task.busy},
      {size: 'medium', content: t(sendingToTrash ? 'trash' : 'delete'), type: 'submit', form, buttonType: 'danger',
        loading: task.busy, disabled: !writable},
    ]}>
    <Stack as="form" id={form} gap="normal" onSubmit={(event: React.FormEvent) => {
      event.preventDefault()
      if (task.busy || !writable) return
      void task.run(async signal => {
        try {
          if (sendingToTrash) await trash(deviceId, location, action.entry, signal)
          else await remove(deviceId, location, action.entry, recursive, signal)
          if (!signal.aborted) changed()
        } catch (error) {
          if (isStaleEntry(error)) refresh()
          throw error
        }
      })
    }}>
      <p>{t(sendingToTrash ? 'trashHelp' : 'deleteHelp')}</p>
      {!sendingToTrash && action.entry.kind === 'directory' && <FormControl layout="horizontal">
        <Checkbox checked={recursive} disabled={task.busy} onChange={event => setRecursive(event.target.checked)} />
        <FormControl.Label>{t('deleteContents')}</FormControl.Label>
      </FormControl>}
      <ErrorText error={writable ? task.error : new ApiError(403, 'root_access_denied')} />
    </Stack>
  </Modal>
}

export function FileDialog(props: FileDialogProps) {
  const {action} = props
  if (action.kind === 'info') return <InfoDialog {...props} action={action} />
  if (action.kind === 'move') return <MoveDialog {...props} action={action} />
  if (action.kind === 'trash' || action.kind === 'remove') return <RemoveDialog {...props} action={action} />
  return <NameMutationDialog {...props} action={action} />
}
