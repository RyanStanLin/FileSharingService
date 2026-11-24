import {useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject} from 'react'
import {Autocomplete, Button, Dialog, Heading, Stack, type DialogHeaderProps} from '@primer/react'
import {ArrowUpIcon, TerminalIcon} from '@primer/octicons-react'
import {awaitTerminalControl, prepareQuickTerminal, runTerminalCommand, type TerminalSession} from '../api/terminals'
import type {Device, Location} from '../api/types'
import {navigate} from '../files/navigation'
import {useLanguage} from '../i18n'
import {useTask} from '../ui/async'
import {ErrorText} from '../ui/Feedback'
import {QuickRunPreview} from './QuickRunPreview'
import {isQuickPath, useQuickPaths} from './useQuickPaths'
import {useTerminalTranscript} from './useTerminalTranscript'
import styles from './quickRun.module.css'

const noSelection: string[] = []

function Label({dialogLabelId, title}: DialogHeaderProps) {
  return <Heading as="h2" id={dialogLabelId} className={styles.visuallyHidden}>{title}</Heading>
}

export default function QuickRunDialog({device, filesHref, close, trigger}: {
  device: Device; filesHref: string; close: () => void; trigger: RefObject<HTMLButtonElement | null>
}) {
  const {t} = useLanguage()
  const [value, setValue] = useState('')
  const [composing, setComposing] = useState(false)
  const [submitted, setSubmitted] = useState<string>()
  const [preview, setPreview] = useState<{session: TerminalSession; commandId?: string}>()
  const task = useTask()
  const form = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const typed = value.trim()
  const path = !composing && isQuickPath(typed) ? typed : ''
  const enabled = device.connection.online && device.connection.accessGranted
  const paths = useQuickPaths(device.id, filesHref, path, enabled)
  const transcript = useTerminalTranscript(device.id, preview?.session.id)
  const run = transcript.runs.find(item => item.id === preview?.commandId)
  const running = !!preview?.commandId && run?.exitCode === undefined && transcript.session?.state !== 'terminated'
  const items = paths.suggestions.map((suggestion, index) => ({
    id: `${labelId}-${index}`, text: suggestion.text, metadata: suggestion.target,
    children: <span className={styles.suggestionText}>{suggestion.text}</span>,
  }))

  function change(next: string) {
    setValue(next)
    if (isQuickPath(next.trim())) paths.start()
  }

  function go(location: Location) {
    navigate(location)
    close()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!typed || task.busy || composing || !enabled) return
    setSubmitted(value)
    if (path) {
      if (!paths.pending) void task.run(async signal => {
        const target = await paths.location(path, signal)
        if (!signal.aborted) go(target)
      })
      return
    }
    if (running) return
    const line = typed.startsWith('>') ? typed.slice(1).trim() : typed
    if (!line) return
    void task.run(async signal => {
      const target = await prepareQuickTerminal(device.id, signal)
      if (signal.aborted) return
      setPreview({session: target})
      const session = await awaitTerminalControl(target, signal)
      const {commandId} = await runTerminalCommand(session, line, signal)
      if (signal.aborted) return
      setPreview({session, commandId})
      setValue(current => current === value ? '' : current)
      input.current?.focus()
    })
  }

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing || task.busy) return
    const id = event.currentTarget.getAttribute('aria-activedescendant')
    const active = items.find(item => item.id === id)
    if (event.key === 'Enter') {
      event.preventDefault()
      if (active && path) go(active.metadata)
      else form.current?.requestSubmit()
    } else if (event.key === 'Tab' && !event.shiftKey && path && items.length) {
      const item = active ?? items[0]
      if (item.text !== value) {
        event.preventDefault()
        change(item.text)
      }
    }
  }

  const error = (submitted === value || !value ? task.error : undefined) ?? (path ? paths.error : transcript.error)
  return <Dialog title={t('terminalQuick')} width="960px" className={styles.dialog} initialFocusRef={input}
    returnFocusRef={trigger} onClose={() => { if (!task.busy) close() }} renderHeader={Label} renderFooter={() => null}
    renderBody={() => <form ref={form} className={styles.body} onSubmit={submit}>
      <span id={labelId} className={styles.visuallyHidden}>{t('terminalQuickPlaceholder')}</span>
      <Autocomplete>
        <Stack direction="horizontal" align="center" gap="condensed" padding="cozy" className={styles.bar}>
          <Autocomplete.Input ref={input} size="medium" block className={styles.input} spellCheck={false} name="quick"
            value={value} readOnly={task.busy} leadingVisual={TerminalIcon} placeholder={t('terminalQuickPlaceholder')}
            aria-labelledby={labelId} autoCapitalize="none" maxLength={8192}
            onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {
              setComposing(false)
              change(event.currentTarget.value)
            }} onChange={event => change(event.currentTarget.value)} onKeyDown={keys} />
          <Button size="medium" type="submit" leadingVisual={ArrowUpIcon} loading={task.busy}
            disabled={!typed || !enabled || composing || (path ? paths.pending : running)}>{t('terminalGo')}</Button>
        </Stack>
        {items.length > 0 && <section className={styles.suggestions} aria-label={t('terminalFolders')}>
          <Heading as="h3" className={styles.folders}>{t('terminalFolders')}</Heading>
          <div ref={scroll} className={styles.matches}>
            <Autocomplete.Menu aria-labelledby={labelId} customScrollContainerRef={scroll} selectedItemIds={noSelection}
              selectionVariant="single"
              items={items} emptyStateText={false} filterFn={() => true} onSelectedChange={choice => {
                const chosen = Array.isArray(choice) ? choice[0] : choice
                if (chosen && !task.busy && !composing) go(chosen.metadata)
              }} />
          </div>
        </section>}
        {preview && !path && <QuickRunPreview session={preview.session} run={run} waiting={running || task.busy} close={close} />}
        {Boolean(error) && <div className={styles.feedback}><ErrorText error={error} /></div>}
      </Autocomplete>
    </form>} />
}
