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
import { PermissionPrompt, type PermissionRequest } from './PermissionPrompt.js'
import { toolRisk, trustKey } from '../core/risk.js'
import { Checkpoints } from '../core/checkpoints.js'
import { trustedKeys, addTrust } from '../state/trust.js'
import { setTitle, setProgress, notify } from './termfx.js'
import type { PermissionMode, ToolDisplay } from '../types.js'
import { resolve as resolvePath } from 'node:path'

type Props = {
  provider: Provider
  initialPrompt?: string
  restored?: Message[]
}

type Activity = { label: string; startedAt: number }
type Pending = { req: PermissionRequest; resolve: (d: { allow: true; via?: string } | { allow: false; reason: string }) => void }

const MODES: PermissionMode[] = ['auto', 'plan', 'ask', 'full']
const MODE_INFO: Record<PermissionMode, string> = {
  auto: 'auto — safe steps run, risky ones ask first',
  plan: 'plan — read-only, Darce proposes changes without making them',
  ask: 'ask — Darce asks before every change',
  full: 'full — nothing asks first (use in a sandbox or throwaway branch)',
}

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
  const [pending, setPending] = useState<Pending | null>(null)
  const [tainted, setTainted] = useState(false)

  const messagesRef = useRef<Message[]>(restored ?? [])
  const readFilesRef = useRef(new Set<string>())
  const abortRef = useRef<AbortController | null>(null)
  const lastCtrlC = useRef(0)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkpointsRef = useRef<Checkpoints | null>(null)
  if (!checkpointsRef.current) checkpointsRef.current = new Checkpoints(state.cwd, state.sessionId)
  const notesRef = useRef<string[]>([])
  const lastToolRef = useRef<{ name: string; summary: string; result: string; display?: ToolDisplay } | null>(null)
  const taintedRef = useRef(false)
  const modeRef = useRef(state.mode)
  modeRef.current = state.mode

  useEffect(() => {
    const cps = checkpointsRef.current!
    cps.markBaseline()
    setTitle('darce')
    return () => cps.cleanup()
  }, [])

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
    // Notes about things the user did between turns (e.g. /undo) ride along with the next message
    const notes = notesRef.current.splice(0)
    const content = notes.length ? `${notes.map(n => `[Note from Darce: ${n}]`).join('\n')}\n\n${text}` : text
    messagesRef.current = [...messagesRef.current, { role: 'user', content }]

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
    const approvals = new Map<string, string>()
    const startedAt = Date.now()
    setTitle('darce · working')
    setProgress('busy')

    const authorize = async (call: { id: string; name: string; input: Record<string, unknown> }) => {
      const risk = toolRisk(call.name, call.input, state.cwd)
      const mode = modeRef.current
      const key = call.name === 'Bash' ? trustKey(String(call.input.command ?? '')) : undefined
      if (risk.level === 0 || mode === 'full') return { allow: true as const }
      if (mode === 'plan') return { allow: false as const, reason: 'plan mode is on (read-only). Describe the change instead of making it.' }
      if (key && risk.level < 3 && trustedKeys(state.cwd).has(key)) return { allow: true as const, via: 'trusted' }
      const autoOk = mode === 'auto' && risk.level <= 1 && !(taintedRef.current && call.name === 'Bash')
      if (autoOk) return { allow: true as const }

      if (Date.now() - startedAt > 10_000) notify('Darce needs approval', `${call.name} ${toolSummary(call.name, call.input)}`)
      setActivity(null)
      return new Promise<{ allow: true; via?: string } | { allow: false; reason: string }>(resolveDecision => {
        setPending({
          req: {
            id: call.id,
            name: call.name,
            summary: toolSummary(call.name, call.input),
            detail: call.name === 'Bash' ? String(call.input.command ?? '') : String(call.input.file_path ?? call.input.url ?? ''),
            risk: taintedRef.current && call.name === 'Bash' && risk.level < 2
              ? { level: 2, reason: `${risk.reason} — asked because web content is in this conversation` }
              : risk,
            trustKey: key && risk.level < 3 ? key : undefined,
          },
          resolve: d => {
            setPending(null)
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            resolveDecision(d)
          },
        })
      })
    }

    const beforeChange = (call: { name: string; input: Record<string, unknown> }) => {
      const paths = call.input.file_path ? [String(call.input.file_path)] : []
      checkpointsRef.current?.snapshot(`${call.name} ${toolSummary(call.name, call.input)}`, paths)
    }

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
        authorize,
        beforeChange,
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
            if (event.via) approvals.set(event.id, event.via === 'trusted' ? 'always allowed' : event.via)
            setActivity({ label: `${event.name} ${summary}`.trim(), startedAt: Date.now() })
            break
          }
          case 'tool_result_ready': {
            const summary = summaries.get(event.id) ?? ''
            const filePath = ['Read', 'Edit', 'Write'].includes(event.name) && summary ? resolvePath(state.cwd, summary) : undefined
            commit({
              kind: 'tool',
              id: newId(),
              name: event.name,
              summary,
              result: event.result,
              isError: event.isError,
              durationMs: event.denied ? undefined : event.durationMs,
              display: event.display,
              approval: event.denied ? 'denied' : approvals.get(event.id),
              path: filePath,
            })
            lastToolRef.current = { name: event.name, summary, result: event.result, display: event.display }
            if (event.name === 'WebFetch' && !event.isError) {
              taintedRef.current = true
              setTainted(true)
            }
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            break
          }
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
      const took = Date.now() - startedAt
      setTitle('darce')
      setProgress('off')
      if (took >= 20_000) notify('Darce finished', text.split('\n')[0]!.slice(0, 80))
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
    if (result === '__UNDO__') {
      commit({ kind: 'user', id: newId(), text })
      const r = checkpointsRef.current!.undo()
      if (!r.ok) { commit({ kind: 'system', id: newId(), text: r.reason }); return }
      const files = [...r.restored.map(f => `restored ${f}`), ...r.removed.map(f => `removed ${f}`)]
      commit({ kind: 'system', id: newId(), text: `Undid: ${r.label}\n${files.length ? files.map(f => `  ${f}`).join('\n') : '  no file changes'}\n${checkpointsRef.current!.count} earlier change(s) can still be undone.` })
      notesRef.current.push(`the user undid your change "${r.label}" — those files are back to how they were before it`)
      return
    }
    if (result === '__DIFF__') {
      commit({ kind: 'user', id: newId(), text })
      const diffs = checkpointsRef.current!.sessionDiff()
      if (diffs === null) { commit({ kind: 'system', id: newId(), text: '/diff needs a git repository. /undo still works for Edit and Write.' }); return }
      if (diffs.length === 0) { commit({ kind: 'system', id: newId(), text: 'No files have changed since this session started.' }); return }
      const added = diffs.reduce((n, d) => n + d.added, 0)
      const removed = diffs.reduce((n, d) => n + d.removed, 0)
      commit({ kind: 'system', id: newId(), text: `${diffs.length} file(s) changed this session, +${added} −${removed}` })
      for (const d of diffs) commit({ kind: 'expanded', id: newId(), name: d.created ? 'new file' : 'changed', summary: d.path, result: '', display: d })
      return
    }
    if (result?.startsWith('__MODE__:')) {
      const want = result.slice(9) as PermissionMode
      if (!want) { commit({ kind: 'system', id: newId(), text: `Mode: ${MODE_INFO[state.mode]}\nChoose with /mode auto|ask|plan|full, or press Shift+Tab.` }); return }
      if (!MODES.includes(want)) { commit({ kind: 'system', id: newId(), text: `Unknown mode "${want}". Use auto, ask, plan or full.` }); return }
      setState(prev => ({ ...prev, mode: want }))
      commit({ kind: 'system', id: newId(), text: `Mode: ${MODE_INFO[want]}` })
      return
    }
    if (result === '__QUIT__') { exit(); return }
    if (/^\/(clear|c)\b/.test(text)) { clearScreen(); return }
    if (/^\/compact\b/.test(text)) return
    commit({ kind: 'user', id: newId(), text })
    if (result) commit({ kind: 'system', id: newId(), text: result })
  }, [state.currentModel, state.cwd, state.mode, setState, exit, clearScreen, commit])

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
    if (pending) {
      const lower = input.toLowerCase()
      if (lower === 'y') pending.resolve({ allow: true, via: 'approved by you' })
      else if (lower === 'a' && pending.req.trustKey) {
        addTrust(state.cwd, pending.req.trustKey)
        pending.resolve({ allow: true, via: `always allow "${pending.req.trustKey}"` })
      } else if (lower === 'n') pending.resolve({ allow: false, reason: 'the user denied this action. Ask what they would like instead, or try a safer approach.' })
      else if (key.escape || (key.ctrl && input === 'c')) {
        pending.resolve({ allow: false, reason: 'the user denied this action and stopped the task.' })
        abortRef.current?.abort()
        setQueue([])
      }
      return
    }
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
      case 'cycleMode': {
        const next = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]!
        setState(prev => ({ ...prev, mode: next }))
        flashHint(`Mode: ${MODE_INFO[next]}`, 3000)
        return
      }
      case 'expand':
        if (lastToolRef.current) {
          const l = lastToolRef.current
          commit({ kind: 'expanded', id: newId(), name: l.name, summary: l.summary, result: l.result, display: l.display })
        }
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

  usePaste(text => dispatch({ type: 'insert', text }), { isActive: !showPicker && !pending })

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

        {pending ? <PermissionPrompt req={pending.req} /> : null}

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

        <Prompt editor={editor} busy={busy} dimmed={showPicker || !!pending} />
        <StatusBar model={state.currentModel} cwd={state.cwd} contextTokens={contextTokens} hint={hint} mode={state.mode} tainted={tainted} />
      </Box>
    </>
  )
}
