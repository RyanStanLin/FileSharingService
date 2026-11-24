import {useRef, useState, type FormEvent} from 'react'
import {Button, Stack, Textarea} from '@primer/react'
import {ArrowUpIcon, StopIcon, TerminalIcon, XIcon} from '@primer/octicons-react'
import {interruptTerminal, runTerminalCommand, terminateTerminal, type TerminalSession} from '../api/terminals'
import {useLanguage} from '../i18n'
import {useTask} from '../ui/async'
import {ErrorText} from '../ui/Feedback'
import styles from './terminalComposer.module.css'
import output from './terminalOutput.module.css'

export function TerminalComposer({session, prompt, hasCommand, follow}: {
  session: TerminalSession; prompt?: string; hasCommand: (id: string) => boolean; follow?: () => void
}) {
  const {t} = useLanguage()
  const [line, setLine] = useState('')
  const [submitted, setSubmitted] = useState<string>()
  const [ending, setEnding] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const task = useTask()
  const awaitingFrame = !!submitted && !hasCommand(submitted)
  const locked = !session.canControl || !!session.commandId || awaitingFrame || task.busy || ending
  const terminating = ending || session.state === 'terminating'
  if (session.state === 'terminated') return null

  function submit(event: FormEvent) {
    event.preventDefault()
    const command = line.trim()
    if (!command || locked) return
    void task.run(async signal => {
      const result = await runTerminalCommand(session, command, signal)
      if (signal.aborted) return
      setSubmitted(result.commandId)
      setLine(current => current.trim() === command ? '' : current)
      follow?.()
    })
  }

  return <div className={styles.composer}>
    {Boolean(task.error) && <div className={styles.feedback}><ErrorText error={task.error} /></div>}
    {prompt && <div className={`${styles.shellPrompt} ${output.prompt}`}>{prompt}</div>}
    <Stack as="form" ref={form} direction="horizontal" gap="condensed" align="end" padding="cozy"
      className={styles.form} onSubmit={submit}>
      <TerminalIcon className={styles.icon} />
      <Textarea block rows={1} resize="none" autoSize className={styles.commandInput} aria-label={t('terminalCommandLabel')}
        placeholder={t('terminalCommandPlaceholder')} maxLength={8192} spellCheck={false} autoCapitalize="none" value={line}
        onChange={event => setLine(event.currentTarget.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault()
            form.current?.requestSubmit()
          }
        }} />
      <Stack direction="horizontal" gap="condensed" className={styles.actions}>
        {session.canControl && session.commandStarted && !terminating && <Button type="button" size="medium" leadingVisual={StopIcon}
          disabled={task.busy} onClick={() => { void task.run(signal => interruptTerminal(session, signal)) }}>{t('terminalInterrupt')}</Button>}
        <Button type="button" size="medium" variant="danger" leadingVisual={XIcon} disabled={terminating || task.busy}
          onClick={() => { void task.run(async signal => {
            await terminateTerminal(session, signal)
            if (!signal.aborted) setEnding(true)
          }) }}>{t('terminalTerminate')}</Button>
        <Button size="medium" type="submit" leadingVisual={ArrowUpIcon} disabled={locked || !line.trim()}>{t('terminalSend')}</Button>
      </Stack>
    </Stack>
  </div>
}
