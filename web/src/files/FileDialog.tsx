import {useId, useRef, useState} from 'react'
import {Button, Checkbox, FormControl, ProgressBar, Stack, TextInput} from '@primer/react'
import {ApiError} from '../api/client'
import {mkdir, move, remove, rename, stat, trash} from '../api/files'
import {upload} from '../api/transfers'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage, type Message} from '../i18n'
import {ErrorText, Loading} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource, useTask} from '../ui/async'
import type {FileAction} from './actions'
import {Metadata} from './Metadata'
import {basename, join, parent} from './navigation'
import {MovePicker} from './MovePicker'

interface Props {
  action: FileAction
  deviceId: string
  share: Share
  location: Location
  hidden: boolean
  roots: Share[]
  close: () => void
  changed: (entry?: Entry) => void
  refresh: () => void
}

type Mutation = Exclude<FileAction, {kind: 'info'}>

const title: Record<Mutation['kind'], Message> = {
  mkdir: 'newFolder', upload: 'addFile',
  rename: 'renameEntry', move: 'moveEntry', trash: 'trashEntry', remove: 'deleteEntry',
}

const submitLabel: Record<Mutation['kind'], Message> = {
  mkdir: 'newFolder', upload: 'upload', rename: 'rename', move: 'moveHere', trash: 'trash', remove: 'delete',
}

function InfoDialog({action, location, deviceId, close}: Props) {
  const {t} = useLanguage()
  const [calculate, setCalculate] = useState(false)
  const target = 'entry' in action && action.entry ? {...location, path: action.entry.path} : location
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

function validName(name: string) {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\/\x00-\x1f\x7f]/.test(name)
}

function MutationDialog({action, deviceId, location, roots, share, hidden, close, changed, refresh}: Omit<Props, 'action'> & {action: Mutation}) {
  const {t, locale} = useLanguage()
  const form = useId()
  const filePicker = useRef<HTMLInputElement>(null)
  const entry = 'entry' in action ? action.entry : undefined
  const task = useTask()
  const [name, setName] = useState(entry?.name ?? '')
  const [chosenFile, chooseFile] = useState<File>()
  const [invalid, setInvalid] = useState(false)
  const [progress, setProgress] = useState(0)
  const [recursive, setRecursive] = useState(false)
  const origin = entry ? parent(entry.path) : location.path
  const [target, setTarget] = useState<Location>({...location, path: origin, kind: 'folder'})
  const allowedTargets = roots.filter(root => root.writable)
  const destructive = action.kind === 'trash' || action.kind === 'remove'
  const canMove = target.rootId !== share.id || (
    target.path !== origin && (!entry || !(target.path === entry.path || target.path.startsWith(entry.path + '/')))
  )
  const canClose = !task.busy || action.kind === 'upload'
  const hasName = action.kind === 'mkdir' || action.kind === 'rename'

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (task.busy || (action.kind === 'move' && !canMove)) return
    if ((hasName && !validName(name)) || (action.kind === 'upload' && !chosenFile)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    void task.run(async signal => {
      try {
        let result: Entry | undefined
        if (action.kind === 'mkdir') result = await mkdir(deviceId, location, join(location.path, name), signal)
        if (action.kind === 'upload' && chosenFile) {
          setProgress(0)
          result = await upload(deviceId, share.id, join(location.path, chosenFile.name), chosenFile, setProgress, signal)
        }
        if (action.kind === 'rename') result = await rename(deviceId, location, action.entry, name, signal)
        if (action.kind === 'move') result = await move(deviceId, location, action.entry,
          join(target.path, basename(action.entry.path)), target.rootId, signal)
        if (action.kind === 'trash') await trash(deviceId, location, action.entry, signal)
        if (action.kind === 'remove') await remove(deviceId, location, action.entry, recursive, signal)
        if (!signal.aborted) changed(result)
      } catch (error) {
        if (error instanceof ApiError && ['version_mismatch', 'not_found', 'delete_incomplete'].includes(error.code)) refresh()
        throw error
      }
    })
  }

  return (
    <Modal title={t(title[action.kind], {name: entry?.name ?? ''})}
      role={destructive ? 'alertdialog' : 'dialog'}
      onClose={() => { if (canClose) close() }}
      footerButtons={[
        {size: 'medium', content: t('cancel'), onClick: close, disabled: !canClose},
        {size: 'medium', content: t(submitLabel[action.kind]),
          type: 'submit', form, buttonType: destructive ? 'danger' : 'primary', loading: task.busy,
          disabled: (action.kind === 'move' && !canMove) || (action.kind === 'rename' && name === entry?.name)},
      ]}>
      <Stack as="form" id={form} onSubmit={submit} gap="normal">
        {hasName && <FormControl required>
          <FormControl.Label>{t('name')}</FormControl.Label>
          <TextInput size="medium" block value={name} autoComplete="off" disabled={task.busy}
            onChange={event => { setName(event.target.value); setInvalid(false) }} />
          {invalid && <FormControl.Validation variant="error">{t('invalidName')}</FormControl.Validation>}
        </FormControl>}
        {action.kind === 'move' && (
          <MovePicker device={deviceId} roots={allowedTargets} source={location} entry={action.entry}
            target={target} hidden={hidden} onTarget={setTarget} />
        )}
        {action.kind === 'upload' && <Stack gap="condensed">
          <input type="file" ref={filePicker} hidden onChange={event => {
            chooseFile(event.target.files?.[0])
            setInvalid(false)
          }} />
          <Stack direction="horizontal" align="center" wrap="wrap" gap="condensed">
            <Button size="medium" disabled={task.busy} onClick={() => filePicker.current?.click()}>{t('chooseFile')}</Button>
            <span role={invalid ? 'alert' : undefined}>{chosenFile?.name ?? t('noChosenFile')}</span>
          </Stack>
          {task.busy && chosenFile && <>
            <span role="status">{t('uploading', {name: chosenFile.name, percent: new Intl.NumberFormat(locale, {style: 'percent'}).format(progress)})}</span>
            <ProgressBar progress={progress * 100} aria-label={t('upload')} />
          </>}
        </Stack>}
        {destructive && <p>{t(action.kind === 'trash' ? 'trashHelp' : 'deleteHelp')}</p>}
        {action.kind === 'remove' && action.entry.kind === 'directory' && <FormControl layout="horizontal">
          <Checkbox checked={recursive} disabled={task.busy} onChange={event => setRecursive(event.target.checked)} />
          <FormControl.Label>{t('deleteContents')}</FormControl.Label>
        </FormControl>}
        <ErrorText error={task.error} />
      </Stack>
    </Modal>
  )
}

export function FileDialog(props: Props) {
  return props.action.kind === 'info' ? <InfoDialog {...props} /> : <MutationDialog {...props} action={props.action} />
}
