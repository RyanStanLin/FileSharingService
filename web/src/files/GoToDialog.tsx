import {useId, useRef, useState, type FormEvent, type KeyboardEvent} from 'react'
import {Autocomplete, FormControl, Stack} from '@primer/react'
import {ApiError} from '../api/client'
import {stat} from '../api/files'
import type {Entry, Location, Share} from '../api/types'
import {useLanguage} from '../i18n'
import {ErrorText} from '../ui/Feedback'
import {Modal} from '../ui/Modal'
import {useResource, useTask} from '../ui/async'
import {readSharedPaths, resolvePath, suggestPaths, type PathCache} from './goToPaths'
import {locationOf, navigate} from './navigation'
import styles from './goTo.module.css'

interface Props {
  device: string
  shares: Share[]
  location: Location
  rootEntry?: Entry
  hidden: boolean
  close: () => void
}

const noSelectedPaths: string[] = []
const noSharedPaths = new Map<string, string>()

export function GoToDialog({device, shares, location, rootEntry, hidden, close}: Props) {
  const {t} = useLanguage()
  const formId = useId()
  const labelId = useId()
  const input = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [loadRoots, setLoadRoots] = useState(false)
  const [composing, setComposing] = useState(false)
  const [submitted, setSubmitted] = useState<string>()
  const [cache] = useState<PathCache>(() => new Map())
  const task = useTask()
  const absolute = value.startsWith('/')
  const rootKey = JSON.stringify(shares.map(share => [share.id, share.revision]))
  const rootPaths = useResource(loadRoots ? rootKey : null, signal =>
    readSharedPaths(device, shares, {id: location.rootId, path: rootEntry?.fullPath}, signal))
  const known = rootEntry ? new Map([[location.rootId, rootEntry.fullPath]]) : noSharedPaths
  const context = {shares, location, roots: rootPaths.data ?? known}
  const suggestKey = !value || composing || (absolute && !rootPaths.data) ? null : value
  const suggestions = useResource(suggestKey, signal => suggestPaths(device, value, context, hidden, cache, signal))
  const items = (suggestions.data ?? []).map((suggestion, index) => ({
    id: `${formId}-path-${index}`, text: suggestion.text, metadata: suggestion.target,
  }))
  const waitingForRoots = absolute && !rootPaths.data && !rootPaths.error

  function change(next: string) {
    setValue(next)
    if (next.startsWith('/')) setLoadRoots(true)
  }

  function go(target: Location) {
    navigate(target)
    close()
  }

  function submitPath() {
    if (!value || composing || task.busy) return
    setSubmitted(value)
    void task.run(async signal => {
      let target: Location
      try {
        target = resolvePath(value, context)
      } catch (error) {
        if (!waitingForRoots || !(error instanceof ApiError) || error.code !== 'path_not_shared') throw error
        const roots = await readSharedPaths(device, shares, {id: location.rootId, path: rootEntry?.fullPath}, signal)
        target = resolvePath(value, {...context, roots})
      }
      const entry = await stat(device, target, signal)
      if (value.endsWith('/') && entry.kind !== 'directory') throw new ApiError(400, 'invalid_path')
      if (!signal.aborted) go(locationOf(target.rootId, entry))
    })
  }

  function onPathKey(event: KeyboardEvent<HTMLInputElement>) {
    if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || task.busy) return
    const expanded = event.currentTarget.getAttribute('aria-expanded') === 'true'
    const activeId = event.currentTarget.getAttribute('aria-activedescendant')
    const highlighted = expanded ? items.find(item => item.id === activeId) : undefined
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlighted) go(highlighted.metadata)
      else submitPath()
      return
    }
    if (event.key !== 'Tab' || event.shiftKey || !expanded) return
    const active = highlighted ?? items[0]
    if (!active || active.text === value) return
    event.preventDefault()
    event.currentTarget.value = active.text
    event.currentTarget.setSelectionRange(active.text.length, active.text.length)
    change(active.text)
  }

  return <Modal title={t('goTo')} width="large" initialFocusRef={input} onClose={close} footerButtons={[
    {size: 'medium', content: t('cancel'), onClick: close},
    {size: 'medium', type: 'submit', form: formId, content: t('goTo'), buttonType: 'primary',
      loading: task.busy, disabled: !value || composing},
  ]}>
    <Stack as="form" id={formId} onSubmit={(event: FormEvent) => {
      event.preventDefault()
      submitPath()
    }} gap="condensed">
      <FormControl>
        <FormControl.Label id={labelId}>{t('path')}</FormControl.Label>
        <Autocomplete>
          <Autocomplete.Input ref={input} size="medium" block value={value} spellCheck={false} name="path" readOnly={task.busy}
            autoCapitalize="none" placeholder="~/Downloads/" onChange={event => change(event.currentTarget.value)}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {
              setComposing(false)
              change(event.currentTarget.value)
            }} onKeyDown={onPathKey} />
          <div className={styles.suggestions} ref={scroll}>
            <Autocomplete.Menu selectedItemIds={noSelectedPaths} items={items} aria-labelledby={labelId}
              customScrollContainerRef={scroll} emptyStateText={false}
              filterFn={item => item.text.toLowerCase().normalize('NFC').startsWith(value.toLowerCase().normalize('NFC'))}
              onSelectedChange={selected => {
                const chosen = Array.isArray(selected) ? selected[0] : selected
                if (chosen && !task.busy && !composing) go(chosen.metadata)
              }} />
          </div>
        </Autocomplete>
      </FormControl>
      {(suggestions.pending || waitingForRoots) && <span role="status" className={styles.status}>{t('lookingUpPaths')}</span>}
      <ErrorText error={task.busy ? undefined : (submitted === value ? task.error : undefined) ?? suggestions.error ?? rootPaths.error} />
    </Stack>
  </Modal>
}
