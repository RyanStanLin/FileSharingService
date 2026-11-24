import {useCallback, useEffect, useRef, useState} from 'react'
import type {TerminalFrame, TerminalSession} from '../api/terminals'
import {streamTerminal} from './terminalStream'
import {TerminalText} from './terminalText'

export interface TerminalRun {
  id: string
  line: string
  prompt: string
  output: string
  interactive: boolean
  clipped: boolean
  exitCode?: number
  code?: string
}

interface Transcript {
  runs: TerminalRun[]
  prompt?: string
  session?: TerminalSession
  error?: unknown
  pending: boolean
}

function collectTranscript() {
  let prompt = ''
  const runs = new Map<string, {run: TerminalRun; reader: TerminalText}>()

  function append(frame: TerminalFrame) {
    if (frame.kind === 'ready' || frame.kind === 'exit' || frame.kind === 'command') prompt = frame.prompt ?? prompt
    if (frame.kind === 'command') {
      runs.set(frame.commandId, {reader: new TerminalText(), run: {
        id: frame.commandId, line: frame.line, prompt, output: '', interactive: false, clipped: false,
      }})
    } else if (frame.kind === 'output' || frame.kind === 'exit') {
      const entry = runs.get(frame.commandId)
      if (!entry) return
      const {reader, run} = entry
      reader.write(frame.kind === 'output' ? frame.data : undefined)
      entry.run = {...run, output: reader.output, interactive: reader.interactive, clipped: reader.clipped,
        ...(frame.kind === 'exit' ? {exitCode: frame.exitCode, code: frame.code} : {})}
    }
  }

  return {
    append,
    read: () => ({prompt, runs: [...runs.values()].map(entry => entry.run)}),
  }
}

const empty: Transcript = {pending: true, runs: []}

export function useTerminalTranscript(deviceId: string, id?: string, archived = false) {
  const initialArchive = useRef(archived)
  initialArchive.current = archived
  const [state, setState] = useState<Transcript>(empty)
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision(count => count + 1), [])
  useEffect(() => {
    setState(empty)
    if (!id) return
    const transcript = collectTranscript()
    const stream = streamTerminal({deviceId, id}, {
      page(page) {
        page.items.forEach(transcript.append)
        setState(previous => ({...previous, ...(page.items.length ? transcript.read() : {}),
          session: page.session, error: undefined, pending: false}))
      },
      mode(_, error) {
        if (error) setState(previous => ({...previous, error, pending: false}))
      },
    }, initialArchive.current)
    return stream.stop
  }, [deviceId, id, revision])
  return {...(state.session && state.session.id !== id ? empty : state), retry}
}
