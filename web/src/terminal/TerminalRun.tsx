import {memo} from 'react'
import {ApiError} from '../api/client'
import {useLanguage} from '../i18n'
import type {TerminalRun as Run} from './useTerminalTranscript'
import styles from './terminalOutput.module.css'

export const TerminalRun = memo(function TerminalRun({run, preview}: {run: Run; preview?: boolean}) {
  const {t, errorText} = useLanguage()
  return <article className={styles.command} data-preview={preview || undefined}>
    <div className={styles.commandLine}>
      {run.prompt && <span className={styles.prompt}>{run.prompt}</span>}
      <code>{run.line}</code>
    </div>
    {run.interactive ? <p className={styles.note}>{t('terminalScreenOutput')}</p>
      : run.output && <pre className={styles.output}>{run.output.replace(/\n$/, '')}</pre>}
    {run.clipped && !run.interactive && <p className={styles.note}>{t('terminalOutputPreview')}</p>}
    {run.exitCode != null && (run.exitCode !== 0 || run.code) && <p className={styles.exit}>
      {run.code ? `${errorText(new ApiError(0, run.code))} · ` : ''}{t('terminalExit', {code: run.exitCode})}
    </p>}
  </article>
})
