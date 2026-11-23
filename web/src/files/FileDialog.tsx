import {useId, useState} from 'react'
import {Button, Checkbox, FormControl, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {remove, stat, trash} from '../api/files'
import {useLanguage} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource, useTask} from '../ui/async'
import type {FileAction, FileDialogProps} from './actions'
import {isStaleEntry} from './fileName'
import {Metadata} from './Metadata'
import {NameMutationDialog} from './NameMutationDialog'
import {canWriteEntry} from './navigation'
import entryStyles from './entryIcon.module.css'

type InfoAction = Extract<FileAction, {kind: 'info'}>
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
        {entry && <><strong className={entry.hidden ? entryStyles.hiddenName : undefined}>{entry.name}</strong><Metadata entry={entry} all /></>}
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
  if (action.kind === 'trash' || action.kind === 'remove') return <RemoveDialog {...props} action={action} />
  return <NameMutationDialog {...props} action={action} />
}
