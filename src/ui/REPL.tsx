import React, { useState, useCallback, useRef, useReducer, useEffect } from 'react'
import { Box, Static, Text, useInput, usePaste, useApp, useStdout } from 'ink'
import { homedir } from 'node:os'
import { Prompt } from './Prompt.js'
import { StatusBar } from './StatusBar.js'
import { ModelPicker } from './ModelPicker.js'
import { Markdown } from './Markdown.js'
import { Spinner } from './Spinner.js'
import { useAppState } from './App.js'
import { theme } from './theme.js'
import { splitStable, closeOpenFence } from './markdownStream.js'
import { editorReducer, emptyEditor } from './input/editor.js'
import { intentFor } from './input/keys.js'
import { TranscriptItemView, newId, toolSummary, type TranscriptItem } from './transcript.js'
import { query } from '../core/query.js'
import { buildSystemPrompt } from '../core/context.js'
import { compactMessages } from '../core/conversation.js'
import { selectModel } from '../providers/router.js'
import { executeCommand } from '../core/commands.js'
import { saveSession } from '../state/sessions.js'
import { loadHistory, saveHistory } from '../state/history.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import type { CommandContext } from '../core/commands.js'
import type { ContentBlock, Message } from '../types.js'
import type { Provider } from '../providers/provider.js'
import { VERSION } from '../version.js'

type Props = {
  provider: Provider
  initialPrompt?: string
  restored?: Message[]
}

type Activity = { label: string; startedAt: number }

const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

function shortCwd(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

/** Rebuild the visible transcript from a saved conversation (for --resume). */
export function itemsFromMessages(messages: Message[]): TranscriptItem[] {
  const results = new Map<string, { content: string; isError?: boolean }>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, { content: b.content, isError: b.is_error })
    }
  }

  const items: TranscriptItem[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.role === 'user') items.push({ kind: 'user', id: newId(), text: m.content })
      else if (m.role === 'assistant' && m.content.trim()) items.push({ kind: 'assistant', id: newId(), text: m.content })
      continue
    }
    for (const b of m.content as ContentBlock[]) {
      if (b.type === 'text' && b.text.trim()) items.push({ kind: 'assistant', id: newId(), text: b.text })
      if (b.type === 'tool_use') {
        const r = results.get(b.id)
        items.push({ kind: 'tool', id: newId(), name: b.name, summary: toolSummary(b.name, b.input), result: r?.content ?? '', isError: r?.isError })
      }
    }
  }
  return items
}

export function REPL({ provider, initialPrompt, restored }: Props) {
  const { state, setState } = useAppState()
  const { exit } = useApp()
  const { write } = useStdout()
  const t = theme()

  const banner = useCallback((): TranscriptItem => ({
    kind: 'banner',
    id: newId('b'),
    version: VERSION,
    model: state.currentModel,
    cwd: shortCwd(state.cwd),
  }), [state.currentModel, state.cwd])

  const [items, setItems] = useState<TranscriptItem[]>(() => {
    const initial: TranscriptItem[] = [banner()]
    if (restored?.length) {
      initial.push(...itemsFromMessages(restored))
      initial.push({ kind: 'system', id: newId(), text: `Resumed session ${state.sessionId.slice(0, 8)} (${restored.length} messages).` })
    }
    return initial
  })
  const [staticKey, setStaticKey] = useState(0)
  const [editor, dispatch] = useReducer(editorReducer, undefined, () => emptyEditor(loadHistory()))
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [tail, setTail] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [hint, setHint] = useState<string | undefined>()
  const [contextTokens, setContextTokens] = useState(() => estimateMessagesTokens(restored ?? []))

  const messagesRef = useRef<Message[]>(restored ?? [])
  const readFilesRef = useRef(new Set<string>())
  const abortRef = useRef<AbortController | null>(null)
  const lastCtrlC = useRef(0)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commit = useCallback((item: TranscriptItem) => setItems(prev => [...prev, item]), [])

  const flashHint = useCallback((text: string, ms = 2000) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(undefined), ms)
  }, [])

  const clearScreen = useCallback(() => {
    write(CLEAR_SCREEN)
    setItems([banner()])
    setStaticKey(k => k + 1)
  }, [write, banner])

  const runQuery = useCallback(async (text: string) => {
    setBusy(true)
    commit({ kind: 'user', id: newId(), text })
    messagesRef.current = [...messagesRef.current, { role: 'user', content: text }]

    const controller = new AbortController()
    abortRef.current = controller
    setActivity({ label: 'Thinking', startedAt: Date.now() })

    const model = state.modelOverride || selectModel(messagesRef.current, state.config.router)
    setState(prev => ({ ...prev, currentModel: model }))

    // Streaming text: complete markdown blocks are frozen into the transcript,
    // only the unfinished tail stays in the live region.
    let buffer = ''
    let committedUpTo = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = (final: boolean) => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      const pending = buffer.slice(committedUpTo)
      if (final) {
        if (pending.trim()) commit({ kind: 'assistant', id: newId(), text: pending.trim() })
        committedUpTo = buffer.length
        setTail('')
        return
      }
      const { stable, tail: rest } = splitStable(pending)
      if (stable.trim()) commit({ kind: 'assistant', id: newId(), text: stable.trim() })
      committedUpTo += stable.length
      setTail(rest)
    }

    const summaries = new Map<string, string>()

    try {
      const gen = query({
        messages: messagesRef.current,
        model,
        provider,
        cwd: state.cwd,
        systemPrompt: buildSystemPrompt(state.cwd),
        maxTurns: state.config.maxTurns,
        readFiles: readFilesRef.current,
        abortSignal: controller.signal,
        passEnv: state.config.passEnv,
      })

      let result = await gen.next()
      while (!result.done) {
        const event = result.value
        switch (event.type) {
          case 'request_start':
            buffer = ''
            committedUpTo = 0
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            break
          case 'text_delta':
            buffer += event.text
            setActivity(null)
            if (!flushTimer) flushTimer = setTimeout(() => flush(false), 40)
            break
          case 'tool_use_start':
            setActivity({ label: `Preparing ${event.name}`, startedAt: Date.now() })
            break
          case 'message_complete':
            flush(true)
            break
          case 'tool_executing': {
            const summary = toolSummary(event.name, event.input)
            summaries.set(event.id, summary)
            setActivity({ label: `${event.name} ${summary}`.trim(), startedAt: Date.now() })
            break
          }
          case 'tool_result_ready':
            commit({
              kind: 'tool',
              id: newId(),
              name: event.name,
              summary: summaries.get(event.id) ?? '',
              result: event.result,
              isError: event.isError,
              durationMs: event.durationMs,
            })
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            break
          case 'error':
            flush(true)
            commit({ kind: 'error', id: newId(), text: event.error })
            break
        }
        result = await gen.next()
      }

      messagesRef.current = result.value.messages
      if (result.value.reason === 'aborted') {
        flush(true)
        commit({ kind: 'system', id: newId(), text: 'Stopped. Send a message to continue.' })
      } else if (result.value.reason === 'max_turns') {
        commit({ kind: 'system', id: newId(), text: `Stopped after ${state.config.maxTurns} steps. Send a message to keep going.` })
      }
    } catch (err) {
      flush(true)
      commit({ kind: 'error', id: newId(), text: (err as Error).message })
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      setTail('')
      setActivity(null)
      abortRef.current = null
      setContextTokens(estimateMessagesTokens(messagesRef.current))
      if (messagesRef.current.length > 0) saveSession(state.sessionId, messagesRef.current, state.cwd)
      setBusy(false)
    }
  }, [state, provider, setState, commit])

  const handleCommand = useCallback((text: string) => {
    const ctx: CommandContext = {
      setModel: (model: string) => setState(prev => ({ ...prev, modelOverride: model, currentModel: model })),
      currentModel: state.currentModel,
      clearMessages: () => {
        if (text.startsWith('/compact')) {
          const before = messagesRef.current.length
          messagesRef.current = compactMessages(messagesRef.current)
          setContextTokens(estimateMessagesTokens(messagesRef.current))
          commit({ kind: 'system', id: newId(), text: before === messagesRef.current.length
            ? 'Nothing to compact yet.'
            : `Compacted ${before} messages to ${messagesRef.current.length}: your first request and the recent context are kept.` })
        } else {
          messagesRef.current = []
          readFilesRef.current.clear()
          setContextTokens(0)
        }
      },
      cwd: state.cwd,
    }

    const result = executeCommand(text, ctx)
    if (result === '__MODEL_PICKER__') { setShowPicker(true); return }
    if (result === '__QUIT__') { exit(); return }
    if (/^\/(clear|c)\b/.test(text)) { clearScreen(); return }
    if (/^\/compact\b/.test(text)) return
    commit({ kind: 'user', id: newId(), text })
    if (result) commit({ kind: 'system', id: newId(), text: result })
  }, [state.currentModel, state.cwd, setState, exit, clearScreen, commit])

  // Run queued messages one after another
  useEffect(() => {
    if (busy || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void runQuery(next!)
  }, [busy, queue, runQuery])

  // Initial prompt from the command line
  const startedInitial = useRef(false)
  useEffect(() => {
    if (initialPrompt && !startedInitial.current) {
      startedInitial.current = true
      void runQuery(initialPrompt)
    }
  }, [initialPrompt, runQuery])

  useInput((input, key) => {
    const intent = intentFor(input, key)
    switch (intent.kind) {
      case 'interrupt':
        if (busy) {
          abortRef.current?.abort()
          setQueue([])
          return
        }
        if (editor.text) {
          dispatch({ type: 'clear' })
          return
        }
        if (Date.now() - lastCtrlC.current < 1500) {
          exit()
          return
        }
        lastCtrlC.current = Date.now()
        flashHint('Press Ctrl+C again to exit', 1500)
        return
      case 'escape':
        if (busy) {
          abortRef.current?.abort()
          setQueue([])
        }
        return
      case 'modelPicker':
        if (!busy) setShowPicker(true)
        return
      case 'clearScreen':
        if (!busy) clearScreen()
        return
      case 'submit': {
        // A trailing backslash continues onto a new line (works in every terminal)
        if (editor.text.endsWith('\\') && editor.cursor === editor.text.length) {
          dispatch({ type: 'backspace' })
          dispatch({ type: 'newline' })
          return
        }
        const text = editor.text.trim()
        if (!text) return
        const next = editorReducer(editor, { type: 'commit' })
        dispatch({ type: 'commit' })
        saveHistory(next.history)
        if (text.startsWith('/')) {
          if (busy && !/^\/(help|cost)\b/.test(text)) {
            flashHint('Wait for Darce to finish, or press Esc to stop it')
            return
          }
          handleCommand(text)
          return
        }
        if (busy) {
          setQueue(q => [...q, text])
          return
        }
        void runQuery(text)
        return
      }
      case 'edit':
        dispatch(intent.action)
        return
    }
  }, { isActive: !showPicker })

  usePaste(text => dispatch({ type: 'insert', text }), { isActive: !showPicker })

  const handleModelSelect = useCallback((model: string) => {
    setState(prev => ({ ...prev, modelOverride: model, currentModel: model }))
    setShowPicker(false)
    commit({ kind: 'system', id: newId(), text: `Switched to ${model}` })
  }, [setState, commit])

  return (
    <>
      <Static key={staticKey} items={items}>
        {item => <TranscriptItemView key={item.id} item={item} />}
      </Static>

      <Box flexDirection="column">
        {tail ? (
          <Box marginBottom={1}>
            <Markdown text={closeOpenFence(tail)} />
          </Box>
        ) : null}

        {activity ? (
          <Box marginLeft={1} marginBottom={1}>
            <Spinner label={activity.label} startedAt={activity.startedAt} />
          </Box>
        ) : null}

        {queue.map((q, i) => (
          <Text key={i} color={t.faint}>↳ queued: {q.split('\n')[0]}</Text>
        ))}

        {showPicker && (
          <ModelPicker
            currentModel={state.currentModel}
            onSelect={handleModelSelect}
            onClose={() => setShowPicker(false)}
          />
        )}

        <Prompt editor={editor} busy={busy} dimmed={showPicker} />
        <StatusBar model={state.currentModel} cwd={state.cwd} contextTokens={contextTokens} hint={hint} />
      </Box>
    </>
  )
}
