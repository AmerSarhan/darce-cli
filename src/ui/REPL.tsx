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
import { Receipt, type ReceiptData } from './Receipt.js'
import { Tape } from './Tape.js'
import { DerbyBoard } from './DerbyBoard.js'
import { Derby, defaultRacers } from '../core/derby.js'
import { pickCritic, reviewEdit } from '../core/critic.js'
import { DEFAULT_GEARS, gearIndex, shiftGear, priceNote } from '../config/gears.js'
import { createCheckout, openInBrowser } from '../core/billing.js'
import { getTotalCost, getTotalTokens } from '../state/costTracker.js'
import type { FileDiff } from '../utils/diff.js'

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
  const [tape, setTape] = useState<{ index: number; preview: FileDiff[] | null } | null>(null)
  const [derby, setDerby] = useState<{ d: Derby; task: string; selected: number; finished: boolean } | null>(null)
  const [, setDerbyTick] = useState(0)
  const [criticOn, setCriticOn] = useState(!!state.config.critic)
  const lastEsc = useRef(0)
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
  const gears = state.config.gears?.length ? state.config.gears : DEFAULT_GEARS
  // The model is read before every request, so a gear shift applies even mid-task
  const modelRef = useRef(state.modelOverride || state.currentModel)
  const criticRef = useRef(criticOn)
  criticRef.current = criticOn

  useEffect(() => {
    const cps = checkpointsRef.current!
    cps.markBaseline()
    setTitle('darce')
    return () => cps.cleanup()
  }, [])

  const commit = useCallback((item: TranscriptItem) => setItems(prev => [...prev, item]), [])

  useEffect(() => {
    if (state.modelOverride) modelRef.current = state.modelOverride
  }, [state.modelOverride])

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

    if (!state.modelOverride) modelRef.current = selectModel(messagesRef.current, state.config.router)
    setState(prev => ({ ...prev, currentModel: modelRef.current }))
    const costBefore = getTotalCost()
    const tokensBefore = getTotalTokens()
    const receipt: ReceiptData = { files: [], commands: 0, approvedByYou: 0, denied: 0, maxRisk: 0, redacted: 0, models: [], tokens: 0, cost: 0, ms: 0, undoable: true, stopped: false }
    const fileStats = new Map<string, { path: string; added: number; removed: number; created: boolean }>()
    let steps = 0

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
      receipt.maxRisk = Math.max(receipt.maxRisk, risk.level) as ReceiptData['maxRisk']
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

    const beforeChange = (call: { id: string; name: string; input: Record<string, unknown> }) => {
      const paths = call.input.file_path ? [String(call.input.file_path)] : []
      checkpointsRef.current?.snapshot(`${call.name} ${toolSummary(call.name, call.input)}`, paths, call.id)
    }

    try {
      const gen = query({
        messages: messagesRef.current,
        model: () => modelRef.current,
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
            if (receipt.models[receipt.models.length - 1] !== modelRef.current) receipt.models.push(modelRef.current)
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
            steps++
            receipt.redacted += event.redacted ?? 0
            if (event.denied) receipt.denied++
            if (approvals.get(event.id) === 'approved by you') receipt.approvedByYou++
            if (event.name === 'Bash' && !event.denied) receipt.commands++
            if (event.display?.kind === 'diff' && !event.isError) {
              const d = event.display
              const prev = fileStats.get(d.path)
              fileStats.set(d.path, { path: d.path, added: (prev?.added ?? 0) + d.added, removed: (prev?.removed ?? 0) + d.removed, created: prev?.created ?? d.created })
              if (criticRef.current) {
                const criticModel = pickCritic(modelRef.current, state.config.criticModel)
                void reviewEdit(provider, criticModel, text, d).then(v => {
                  if (!v) return
                  commit({ kind: 'critic', id: newId(), model: criticModel, path: d.path, issue: v.ok ? undefined : v.issue })
                  if (!v.ok) notesRef.current.push(`a second reviewer (${criticModel}) flagged your edit to ${d.path}: ${v.issue}`)
                })
              }
            }
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
      if (steps > 0) {
        receipt.files = [...fileStats.values()]
        receipt.tokens = getTotalTokens() - tokensBefore
        receipt.cost = getTotalCost() - costBefore
        receipt.ms = took
        receipt.undoable = checkpointsRef.current!.count > 0
        receipt.stopped = controller.signal.aborted
        commit({ kind: 'receipt', id: newId(), data: receipt })
      }
      if (flushTimer) clearTimeout(flushTimer)
      setTail('')
      setActivity(null)
      abortRef.current = null
      setContextTokens(estimateMessagesTokens(messagesRef.current))
      if (messagesRef.current.length > 0) saveSession(state.sessionId, messagesRef.current, state.cwd)
      setBusy(false)
    }
  }, [state, provider, setState, commit])

  const openTape = useCallback(() => {
    const cps = checkpointsRef.current!
    if (cps.count === 0) { flashHint('Nothing to rewind yet: Darce has not changed anything this session.'); return }
    const index = cps.count - 1
    setTape({ index, preview: cps.stepDiff(index) })
  }, [flashHint])

  const rewindTo = useCallback((index: number) => {
    const cps = checkpointsRef.current!
    const cp = cps.list()[index]
    if (!cp) return
    const r = cps.rewindTo(index)
    setTape(null)
    if (!r.ok) { commit({ kind: 'error', id: newId(), text: r.reason }); return }
    // Cut the conversation back to before the message that made this step
    let cut = -1
    if (cp.toolUseId) {
      cut = messagesRef.current.findIndex(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.id === cp.toolUseId))
    }
    if (cut >= 0) messagesRef.current = messagesRef.current.slice(0, cut)
    setContextTokens(estimateMessagesTokens(messagesRef.current))
    const files = [...r.restored.map(f => `restored ${f}`), ...r.removed.map(f => `removed ${f}`)]
    commit({ kind: 'system', id: newId(), text: `Rewound to before: ${cp.label}\n${files.length ? files.map(f => `  ${f}`).join('\n') : '  no file changes'}${cut >= 0 ? '\nThe conversation was rewound to the same point.' : ''}` })
    notesRef.current.push(`the user rewound the project to before your step "${cp.label}"`)
  }, [commit])

  const startDerby = useCallback(async (args: string) => {
    let rest = args.trim()
    let models: string[] | undefined
    const m = rest.match(/^--models\s+(\S+)\s*/)
    if (m) { models = m[1]!.split(',').filter(Boolean); rest = rest.slice(m[0].length) }
    if (!rest) { commit({ kind: 'system', id: newId(), text: 'Usage: /derby [--models a,b,c] <task>\nRaces up to 3 models on the task, each in its own git worktree. Your files are untouched until you pick a winner.' }); return }
    const cps = checkpointsRef.current!
    const base = cps.commitWorkingTree('darce derby base')
    if (!base || !cps.gitRoot) { commit({ kind: 'system', id: newId(), text: '/derby needs a git repository: each model works in its own worktree.' }); return }
    const racers = (models ?? defaultRacers(modelRef.current, state.config.derbyModels)).slice(0, 3)
    commit({ kind: 'user', id: newId(), text: `/derby ${rest}` })
    const d = new Derby(cps.gitRoot, base, racers, () => setDerbyTick(n => n + 1))
    setDerby({ d, task: rest, selected: 0, finished: false })
    setBusy(true)
    setTitle('darce · derby')
    setProgress('busy')
    const started = Date.now()
    await d.run(rest, messagesRef.current, provider, state.config.passEnv)
    setProgress('off')
    setTitle('darce')
    if (Date.now() - started >= 20_000) notify('Derby finished', 'Pick a winner')
    const best = d.racers.findIndex(r => r.status === 'done' && r.diffs.length > 0)
    setDerby(prev => prev && { ...prev, finished: true, selected: best >= 0 ? best : 0 })
  }, [commit, provider, state.config.derbyModels, state.config.passEnv])

  const finishDerby = useCallback((applyIndex: number | null) => {
    if (!derby) return
    const { d, task } = derby
    if (applyIndex !== null) {
      const r = d.racers[applyIndex]!
      checkpointsRef.current!.snapshot(`Derby: apply ${r.model.split('/').pop()}`)
      const { files } = d.apply(applyIndex)
      commit({ kind: 'system', id: newId(), text: `Applied ${r.model}'s result: ${files} file${files === 1 ? '' : 's'} changed ($${r.cost.toFixed(4)}, ${Math.round(r.ms / 1000)}s). /undo reverts it.` })
      for (const diff of r.diffs) commit({ kind: 'expanded', id: newId(), name: diff.created ? 'new file' : 'changed', summary: diff.path, result: '', display: diff })
      messagesRef.current = [
        ...messagesRef.current,
        { role: 'user', content: task },
        { role: 'assistant', content: `${r.answer.trim() || 'Done.'}\n\n(These changes came from ${r.model} in a model derby and are now applied.)` },
      ]
      setContextTokens(estimateMessagesTokens(messagesRef.current))
    } else {
      d.stop()
      commit({ kind: 'system', id: newId(), text: 'Derby discarded. Your files were not changed.' })
    }
    d.cleanup()
    setDerby(null)
    setBusy(false)
  }, [derby, commit])

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
    if (result === '__REWIND__') { openTape(); return }
    if (result?.startsWith('__UPGRADE__:')) {
      const arg = result.slice(12)
      const plan = arg === 'builder' || arg === 'power' ? arg : undefined
      commit({ kind: 'user', id: newId(), text })
      commit({ kind: 'system', id: newId(), text: 'Creating a secure Stripe checkout…' })
      void createCheckout(state.config.apiKey, state.config.apiBase || undefined, plan).then(r => {
        if ('url' in r) {
          openInBrowser(r.url)
          commit({ kind: 'system', id: newId(), text: `Opened checkout in your browser. If it didn't open:\n${r.url}` })
        } else {
          commit({ kind: r.alreadyPaid ? 'system' : 'error', id: newId(), text: r.alreadyPaid ? "You're already on a paid plan." : r.error })
        }
      })
      return
    }
    if (result?.startsWith('__DERBY__:')) { void startDerby(result.slice(10)); return }
    if (result?.startsWith('__CRITIC__:')) {
      const [arg, model] = result.slice(11).split(/\s+/)
      const on = arg === 'on' ? true : arg === 'off' ? false : !criticOn
      setCriticOn(on)
      commit({ kind: 'system', id: newId(), text: on
        ? `Second opinion on: every edit is reviewed by ${model || state.config.criticModel || pickCritic(modelRef.current)} (a different vendor from the model doing the work). Each review is a small extra request.`
        : 'Second opinion off.' })
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
  }, [state.currentModel, state.cwd, state.mode, state.config.criticModel, setState, exit, clearScreen, commit, openTape, startDerby, criticOn])

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
    if (tape) {
      const cps = checkpointsRef.current!
      const move = (i: number) => setTape({ index: i, preview: cps.stepDiff(i) })
      if (key.leftArrow) move(Math.max(0, tape.index - 1))
      else if (key.rightArrow) move(Math.min(cps.count - 1, tape.index + 1))
      else if (key.return) rewindTo(tape.index)
      else if (key.escape || (key.ctrl && input === 'c')) setTape(null)
      return
    }
    if (derby) {
      if (!derby.finished) {
        if (key.escape || (key.ctrl && input === 'c')) derby.d.stop()
        return
      }
      const n = derby.d.racers.length
      const num = parseInt(input, 10)
      if (num >= 1 && num <= n) setDerby({ ...derby, selected: num - 1 })
      else if (key.upArrow) setDerby({ ...derby, selected: (derby.selected + n - 1) % n })
      else if (key.downArrow) setDerby({ ...derby, selected: (derby.selected + 1) % n })
      else if (key.return) {
        const r = derby.d.racers[derby.selected]!
        if (r.diffs.length) finishDerby(derby.selected)
        else flashHint('That model made no changes. Pick another, or Esc to discard.')
      } else if (key.escape || (key.ctrl && input === 'c')) finishDerby(null)
      return
    }
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
          return
        }
        // Esc twice on an empty prompt opens the rewind tape
        if (!editor.text) {
          if (Date.now() - lastEsc.current < 800) { lastEsc.current = 0; openTape() }
          else lastEsc.current = Date.now()
        }
        return
      case 'gear': {
        const from = modelRef.current
        const to = shiftGear(gears, from, intent.dir)
        if (to === from) { flashHint(intent.dir === 1 ? 'Already in the top gear' : 'Already in the lowest gear'); return }
        modelRef.current = to
        setState(prev => ({ ...prev, modelOverride: to, currentModel: to }))
        flashHint(`${intent.dir === 1 ? '▲' : '▼'} ${to.split('/').pop()}  ${priceNote(to, from)}${busy ? ' · applies from the next step' : ''}`, 3500)
        return
      }
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

  usePaste(text => dispatch({ type: 'insert', text }), { isActive: !showPicker && !pending && !tape && !derby })

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
        {tape ? (
          <Tape
            frames={checkpointsRef.current!.list().map(c => ({ label: c.label, at: c.at }))}
            index={tape.index}
            preview={tape.preview}
          />
        ) : null}
        {derby ? <DerbyBoard task={derby.task} racers={derby.d.racers} selected={derby.selected} finished={derby.finished} /> : null}

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

        <Prompt editor={editor} busy={busy} dimmed={showPicker || !!pending || !!tape || !!derby} />
        <StatusBar
          model={state.currentModel}
          cwd={state.cwd}
          contextTokens={contextTokens}
          hint={hint}
          mode={state.mode}
          tainted={tainted}
          gear={{ index: gearIndex(gears, state.currentModel), total: gears.length }}
          critic={criticOn}
        />
      </Box>
    </>
  )
}
