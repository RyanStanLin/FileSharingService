import {useEffect, useRef, useState} from 'react'
import {FitAddon} from '@xterm/addon-fit'
import {Terminal} from '@xterm/xterm'
import {ApiError} from '../api/client'
import type {TerminalSession} from '../api/terminals'
import {useLanguage} from '../i18n'
import {terminalInput} from './terminalInput'
import {streamTerminal} from './terminalStream'
import {printable, terminalBytes} from './terminalText'
import '@xterm/xterm/css/xterm.css'

interface ScreenState {
  session?: TerminalSession
  prompt?: string
  error?: unknown
  pending: boolean
}

const encoder = new TextEncoder()

export function useImmersiveScreen(deviceId: string, id: string) {
  const {t, errorText} = useLanguage()
  const labels = useRef({t, errorText})
  labels.current = {t, errorText}
  const host = useRef<HTMLDivElement>(null)
  const commands = useRef(new Set<string>())
  const [state, setState] = useState<ScreenState>({pending: true})
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const element = host.current
    if (!element) return
    commands.current.clear()
    setState({pending: true})
    let view: TerminalSession | undefined
    let prompt: string | undefined
    let previousSize: string | undefined
    const computed = getComputedStyle(element)
    const terminal = new Terminal({
      fontFamily: computed.getPropertyValue('--fontStack-monospace').trim(), fontSize: Number.parseFloat(computed.fontSize),
      cursorBlink: true, disableStdin: true, scrollback: 2000,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    terminal.parser.registerOscHandler(52, () => true)
    terminal.textarea?.setAttribute('aria-label', labels.current.t('terminalImmersive'))

    function appearance() {
      const css = getComputedStyle(element!)
      const fg = css.getPropertyValue('--fgColor-default').trim()
      terminal.options.theme = {foreground: fg, cursor: fg, background: css.getPropertyValue('--bgColor-default').trim()}
    }

    function measure() {
      const size = fit.proposeDimensions()
      if (!size || !element?.clientWidth || !element.clientHeight) return
      const rows = Math.max(2, Math.min(size.rows, 160))
      const columns = Math.max(2, Math.min(size.cols, 300))
      if (terminal.rows !== rows || terminal.cols !== columns) terminal.resize(columns, rows)
      const next = `${rows}:${columns}`
      if (view?.canControl && view.interactive && next !== previousSize) {
        previousSize = next
        input.resize(rows, columns)
      }
    }

    const stream = streamTerminal({deviceId, id}, {
      page(page) {
        const gainedControl = !view?.canControl && page.session.canControl
        view = page.session
        const receiving = view.canControl && view.interactive && view.commandStarted
        terminal.options.disableStdin = !receiving
        for (const frame of page.items) {
          if (frame.kind === 'ready' || frame.kind === 'command' || frame.kind === 'exit') prompt = frame.prompt ?? prompt
          if (frame.kind === 'command') {
            commands.current.add(frame.commandId)
            terminal.writeln(printable(`${prompt ?? '%'} ${frame.line}`))
          } else if (frame.kind === 'started' && receiving && frame.commandId === view.commandId) {
            terminal.focus()
          } else if (frame.kind === 'output') {
            terminal.write(terminalBytes(frame.data))
          } else if (frame.kind === 'exit') {
            const status = labels.current.t('terminalExit', {code: frame.exitCode})
            terminal.writeln(`[${status}]`)
          } else if (frame.kind === 'closed' && frame.code) {
            terminal.writeln(`[${labels.current.errorText(new ApiError(0, frame.code))}]`)
          }
        }
        if (gainedControl) {
          previousSize = undefined
          measure()
        }
        setState({session: view, prompt, pending: false})
      },
      mode(_, error) { if (error) setState(previous => ({...previous, error, pending: false})) },
    }, false)
    const input = terminalInput(stream.input, error => {
      previousSize = undefined
      setState(previous => ({...previous, error}))
    })
    function keys(data: Uint8Array) {
      if (view?.canControl && view.interactive && view.commandStarted && view.commandId) input.keys(view.commandId, data)
    }

    terminal.onData(data => keys(encoder.encode(data)))
    terminal.onBinary(data => keys(Uint8Array.from(data, character => character.charCodeAt(0))))
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    const theme = new MutationObserver(appearance)
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
    systemTheme.addEventListener('change', appearance)
    const themed = element.closest('[data-color-mode]')
    if (themed) theme.observe(themed, {attributes: true, attributeFilter: ['data-color-mode', 'data-light-theme', 'data-dark-theme']})
    appearance()
    measure()
    return () => {
      theme.disconnect()
      systemTheme.removeEventListener('change', appearance)
      resize.disconnect()
      input.stop()
      stream.stop()
      terminal.dispose()
    }
  }, [deviceId, id, revision])
  return {...state, host, hasCommand: (commandId: string) => commands.current.has(commandId), retry: () => setRevision(count => count + 1)}
}
