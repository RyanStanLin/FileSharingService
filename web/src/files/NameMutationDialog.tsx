import {useEffect, useId, useRef, useState} from 'react'
import {Checkbox, FormControl, Stack, TextInput} from '@primer/react'
import {ApiError} from '../api/client'
import {mkdir, rename} from '../api/files'
import {upload, uploadLimitBytes, type UploadProgress} from '../api/transfers'
import type {Entry, Location} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useTask} from '../ui/async'
import type {FileAction, FileDialogProps} from './actions'
import {fileNameIssue, findUploadTarget, isNameFault, isStaleEntry, isVersionMismatch} from './fileName'
import {canWriteEntry, canWriteFolder, join, parent} from './navigation'
import {UploadFileField} from './UploadFileField'

type NameAction = Extract<FileAction, {kind: 'mkdir' | 'rename' | 'upload'}>
type FieldError = {field: 'name' | 'file' | 'form'; error: unknown}

const alreadyExists = new ApiError(409, 'already_exists')
const destinationChanged = new ApiError(409, 'upload_destination_changed')

export function NameMutationDialog({action, deviceId, location, share, directoryEntries, close, changed, refresh}: FileDialogProps<NameAction>) {
  const {t, errorText} = useLanguage()
  const formId = useId()
  const input = useRef<HTMLInputElement>(null)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const errorRegion = useRef<HTMLDivElement>(null)
  const task = useTask()
  const renaming = action.kind === 'rename'
  const uploading = action.kind === 'upload'
  const original = renaming ? action.entry : undefined
  const folderPath = renaming ? parent(action.entry.path) : action.folder?.path ?? location.path
  const folder: Location = {rootId: location.rootId, path: folderPath, kind: 'folder'}
  const writable = original ? canWriteEntry(share, original.path) : canWriteFolder(share, folderPath)
  const [name, setName] = useState(original?.name ?? '')
  const [touched, setTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [file, setFile] = useState<File>()
  const [progress, setProgress] = useState<UploadProgress>()
  const uploadPhase = useRef<UploadProgress['phase']>(undefined)
  const [failure, setFailure] = useState<FieldError>()
  const sourceChanged = renaming && isStaleEntry(failure?.error)
  const [observed, setObserved] = useState<{entry?: Entry}>()
  const [replaceVersion, setReplaceVersion] = useState<string>()
  const issue = fileNameIssue(folderPath, name)
  const tooLarge = Boolean(file && file.size > uploadLimitBytes)
  const conflict = observed ? observed.entry : directoryEntries.find(entry =>
    entry.name === name && entry.path !== original?.path && parent(entry.path) === folderPath)
  const replaceable = uploading && conflict?.kind === 'file'
  const replacing = replaceable && replaceVersion === conflict.version
  const untouched = renaming && name === original?.name
  const nameError = ((touched || submitted) && issue ? t(issue) : undefined) ??
    (failure?.field === 'name' ? errorText(failure.error) : undefined) ??
    (conflict && !replacing ? errorText(alreadyExists) : undefined)
  const success = touched && !untouched && !issue && !nameError
  const status = nameError ? 'error' : success ? 'success' : undefined
  const fileError = tooLarge ? t('uploadFileTooLarge') : submitted && !file ? t('uploadFileRequired') :
    failure?.field === 'file' ? errorText(failure.error) : undefined
  const canClose = !task.busy || uploading && progress?.phase !== 'committing'

  useEffect(() => {
    if (task.busy || !failure) return
    const field = failure.field === 'name' ? input : failure.field === 'file' ? chooseButton : errorRegion
    field.current?.focus({preventScroll: true})
  }, [failure, task.busy])

  function changeName(next: string) {
    setName(next)
    setTouched(true)
    if (!sourceChanged) setFailure(undefined)
    setObserved(undefined)
    setReplaceVersion(undefined)
  }

  function updateProgress(value?: UploadProgress) {
    uploadPhase.current = value?.phase
    setProgress(value)
  }

  function closeDialog() {
    if (canClose && uploadPhase.current !== 'committing') close()
  }

  async function uploadIntoFolder(selected: File, signal: AbortSignal) {
    updateProgress({phase: 'preparing', fraction: 0})
    const latest = await findUploadTarget(deviceId, folder, name, signal)
    signal.throwIfAborted()
    setObserved({entry: latest})
    if (latest && replaceVersion !== latest.version || !latest && replaceVersion) {
      setReplaceVersion(undefined)
      setFailure({field: 'name', error: replaceVersion ? destinationChanged : alreadyExists})
      return undefined
    }
    updateProgress({phase: 'uploading', fraction: 0})
    return upload(deviceId, folder.rootId, join(folder.path, name), selected, replaceVersion, updateProgress, signal)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (task.busy || !writable || untouched || sourceChanged) return
    setSubmitted(true)
    setFailure(undefined)
    if (uploading && (!file || tooLarge)) {
      chooseButton.current?.focus()
      return
    }
    if (issue) {
      input.current?.focus()
      return
    }
    void task.run(async signal => {
      try {
        const result = action.kind === 'rename' ? await rename(deviceId, location, action.entry, name, signal)
          : action.kind === 'mkdir' ? await mkdir(deviceId, folder, join(folder.path, name), signal)
          : await uploadIntoFolder(file!, signal)
        if (result && !signal.aborted) changed(result)
      } catch (error) {
        if (signal.aborted) return
        if (isStaleEntry(error)) refresh()
        if (uploading && (isVersionMismatch(error) || error instanceof ApiError && error.code === 'already_exists')) {
          const latest = await findUploadTarget(deviceId, folder, name, signal).catch(() => undefined)
          if (signal.aborted) return
          setObserved({entry: latest})
          setReplaceVersion(undefined)
          setFailure({field: 'name', error: replaceVersion ? destinationChanged : latest ? alreadyExists : error})
        } else {
          const field = isNameFault(error) ? 'name' : uploading && error instanceof ApiError &&
            ['invalid_length', 'too_large', 'upload_source_unreadable'].includes(error.code) ? 'file' : 'form'
          const failure = field === 'name' && error instanceof ApiError && error.code === 'invalid_path'
            ? new ApiError(error.status, 'name_rejected') : error
          setFailure({field, error: failure})
        }
      } finally {
        if (!signal.aborted) updateProgress(undefined)
      }
    })
  }

  const title = renaming ? t('renameEntry', {name: action.entry.name}) : t(uploading ? 'addFile' : 'newFolder')
  return <Modal title={title} subtitle={renaming ? undefined : action.folder?.path} initialFocusRef={uploading ? chooseButton : input}
    onClose={closeDialog}
    footerButtons={[
      {size: 'medium', content: t('cancel'), onClick: closeDialog, disabled: !canClose},
      {size: 'medium', content: t(renaming ? 'rename' : uploading ? 'upload' : 'newFolder'), type: 'submit', form: formId,
        buttonType: 'primary', loading: task.busy, disabled: !writable || untouched || sourceChanged},
    ]}>
    <Stack as="form" id={formId} onSubmit={submit} noValidate gap="normal">
      {(!writable || failure?.field === 'form') && <div ref={errorRegion} tabIndex={-1}>
        <ErrorText error={sourceChanged ? new ApiError(409, 'mutation_source_changed')
          : writable ? failure?.error : new ApiError(403, 'root_access_denied')} />
      </div>}
      {uploading && <UploadFileField file={file} button={chooseButton} problem={fileError} progress={progress} onChoose={selected => {
        setFile(selected)
        changeName(selected.name)
      }} />}
      {(!uploading || file) && <FormControl required>
        <FormControl.Label>{t('name')}</FormControl.Label>
        <TextInput ref={input} size="medium" block value={name} autoComplete="off" readOnly={task.busy}
          validationStatus={status} onChange={event => changeName(event.currentTarget.value)} />
        {status && <FormControl.Validation variant={status}>{nameError ?? t('nameFormatValid')}</FormControl.Validation>}
      </FormControl>}
      {replaceable && <FormControl layout="horizontal">
        <Checkbox checked={replacing} disabled={task.busy} onChange={event => {
          setReplaceVersion(event.target.checked ? conflict.version : undefined)
          setFailure(undefined)
        }} />
        <FormControl.Label>{t('replaceExisting')}</FormControl.Label>
      </FormControl>}
    </Stack>
  </Modal>
}
