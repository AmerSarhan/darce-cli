import React, { useState, useCallback, useRef, useReducer, useEffect, useMemo } from 'react'
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
import { toolRisk, trustKey, isSimpleCommand } from '../core/risk.js'
import { Checkpoints } from '../core/checkpoints.js'
import { trustedKeys, addTrust } from '../state/trust.js'
import { setTitle, setProgress, notify } from './termfx.js'
import type { PermissionMode, ToolDisplay } from '../types.js'
import { resolve as resolvePath } from 'node:path'
import { Receipt, type ReceiptData } from './Receipt.js'
import { Tape } from './Tape.js'
import { DerbyBoard } from './DerbyBoard.js'
import { PlanPanel } from './PlanPanel.js'
import { Intro } from './Welcome.js'
import type { PlanDisplay } from '../types.js'
import { Derby, defaultRacers } from '../core/derby.js'
import { pickCritic, reviewEdit } from '../core/critic.js'
import { DEFAULT_GEARS, gearIndex, shiftGear, priceNote } from '../config/gears.js'
import { createCheckout, openInBrowser } from '../core/billing.js'
import { DISCORD_URL } from '../community.js'
import { readMemory, memoryPath, forget } from '../core/memory.js'
import { listAccounts, addAccount, switchAccount, removeAccount, fetchAccount } from '../auth/accounts.js'
import { browserLogin } from '../auth/browserLogin.js'
import { discoverSkills } from '../core/skills.js'
import { resetContext } from '../core/context.js'
import { completionContext, rank } from './input/complete.js'
import { projectFiles } from './input/files.js'
import { CompletionMenu, type MenuItem } from './CompletionMenu.js'
import { listCommands } from '../core/commands.js'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { clipboardImage, imagePathFrom, attachmentFromFile, toBase64, type Attachment } from './input/images.js'
import { getModelProfile, recordModelUse } from '../config/models.js'
import { predictNext, DEFAULT_SUGGEST_MODEL } from '../core/suggest.js'
import type { ImageContent } from '../types.js'
import { getTotalCost, getTotalTokens } from '../state/costTracker.js'
import type { FileDiff } from '../utils/diff.js'
import { saveGlobalSetting } from '../config/config.js'
import { WHY_NOTE } from '../core/context.js'
import { Narrator, firstNameFromEmail, findPlayer, VOICE_NAMES } from '../core/voice.js'
import { runThread, Mutex, type Thread } from '../core/threads.js'
import type { SpawnRequest } from '../types.js'
import { ThreadsPanel } from './ThreadsPanel.js'
import { planSwarm, laneNote, type SwarmPart } from '../core/swarm.js'
import { trace, recentTrace } from '../utils/logger.js'
import { SessionPicker } from './SessionPicker.js'
import { loadSession, type SessionSummary } from '../state/sessions.js'
import { secondOpinion, wantsSecondOpinion } from '../core/riskcheck.js'

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
      if (b.type === 'text' && b.text.trim()) items.push({ kind: m.role === 'user' ? 'user' : 'assistant', id: newId(), text: b.text })
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

  const accountLine = useRef<string | undefined>(undefined)
  const banner = useCallback((): TranscriptItem => ({
    kind: 'banner',
    id: newId('b'),
    version: VERSION,
    model: state.currentModel,
    cwd: shortCwd(state.cwd),
    mode: state.mode,
    account: accountLine.current,
  }), [state.currentModel, state.cwd, state.mode])

  // The welcome card is committed after the intro animation (and the account lookup) finish
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [introDone, setIntroDone] = useState(false)
  const [accountReady, setAccountReady] = useState(false)
  const finishIntro = useCallback(() => {
    if (introDone) return
    setIntroDone(true)
    const initial: TranscriptItem[] = [banner()]
    if (restored?.length) {
      initial.push(...itemsFromMessages(restored))
      initial.push({ kind: 'system', id: newId(), text: `Resumed session ${state.sessionId.slice(0, 8)} (${restored.length} messages).` })
    }
    setItems(prev => [...initial, ...prev])
  }, [introDone, restored, state.sessionId])
  const [staticKey, setStaticKey] = useState(0)
  const [editor, dispatch] = useReducer(editorReducer, undefined, () => emptyEditor(loadHistory()))
  const [busy, setBusy] = useState(false)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [tail, setTail] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [hint, setHint] = useState<string | undefined>()
  const [contextTokens, setContextTokens] = useState(() => estimateMessagesTokens(restored ?? []))
  const [pending, setPending] = useState<Pending | null>(null)
  const [tape, setTape] = useState<{ index: number; preview: FileDiff[] | null } | null>(null)
  const [derby, setDerby] = useState<{ d: Derby; task: string; selected: number; finished: boolean; variant?: 'derby' | 'swarm' } | null>(null)
  const [, setDerbyTick] = useState(0)
  const [criticOn, setCriticOn] = useState(!!state.config.critic)
  // Threads (sub-agents) from this session; the tick re-renders the live panel
  const threadsRef = useRef<Thread[]>([])
  const workMutexRef = useRef(new Mutex())
  const [, setThreadsTick] = useState(0)
  const bumpThreads = useCallback(() => setThreadsTick(n => n + 1), [])
  const turnThreadsFrom = useRef(0)
  const [livePlan, setLivePlan] = useState<PlanDisplay | null>(null)
  const [learnOn, setLearnOn] = useState(state.config.why !== false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null)
  const [search, setSearch] = useState<{ query: string; skip: number } | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [suggestion, setSuggestion] = useState<string | null>(null)
  // null = decide from the plan once the account loads (on for paid plans, off for free)
  const [suggestOn, setSuggestOn] = useState<boolean | null>(state.config.suggestions ?? null)
  const suggestRef = useRef(suggestOn)
  suggestRef.current = suggestOn
  const imageCounter = useRef(0)

  useEffect(() => { projectFiles(state.cwd) }, [state.cwd])

  // Slash-command and @file suggestions for whatever is at the cursor
  const completion = useMemo(() => {
    if (menuDismissed === editor.text) return null
    const ctx = completionContext(editor)
    if (!ctx) return null
    if (ctx.kind === 'command') {
      const cmds = listCommands()
      const ranked = ctx.query ? rank(cmds, ctx.query, c => [c.name, ...c.aliases].join(' '), 10) : cmds.slice(0, 12)
      if (ranked.length === 1 && ranked[0]!.name === ctx.query && !ranked[0]!.args?.startsWith('<')) return null
      // Only required arguments (<task>) keep the menu open on Enter; optional ones run the command
      return { ctx, items: ranked.map(c => ({ label: `/${c.name}`, hint: c.args, detail: c.description, value: `/${c.name}`, args: !!c.args?.startsWith('<') })) }
    }
    const files = rank(projectFiles(state.cwd), ctx.query, f => f, 8)
    return files.length ? { ctx, items: files.map(f => ({ label: f, value: `@${f}`, args: false })) } : null
  }, [editor, menuDismissed, state.cwd])

  useEffect(() => { setMenuIndex(0) }, [completion?.ctx.kind, completion?.ctx.query])

  const historyMatches = useMemo(() => {
    if (!search) return []
    const q = search.query.toLowerCase()
    return editor.history.filter(h => h.toLowerCase().includes(q))
  }, [search, editor.history])
  const learnRef = useRef(false)
  const [voiceOn, setVoiceOn] = useState(state.config.voice === true)
  const voiceRef = useRef(voiceOn)
  voiceRef.current = voiceOn
  const voiceIdRef = useRef(state.config.voiceId || 'erik')
  const voiceNameRef = useRef(state.config.voiceName || firstNameFromEmail(listAccounts().active))
  const narratorRef = useRef<Narrator | null>(null)
  if (!narratorRef.current) {
    narratorRef.current = new Narrator({
      apiKey: state.config.apiKey,
      apiBase: state.config.apiBase || 'https://api.darce.dev',
      name: () => voiceNameRef.current,
      voice: () => voiceIdRef.current,
    })
  }
  useEffect(() => () => narratorRef.current?.stop(), [])
  learnRef.current = learnOn
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

  // Account line for the welcome card (bounded wait so startup never stalls)
  useEffect(() => {
    let done = false
    const finish = () => { if (!done) { done = true; setAccountReady(true) } }
    const timer = setTimeout(finish, 1200)
    fetchAccount(state.config.apiKey, state.config.apiBase || undefined).then(info => {
      if (info) {
        const plan = info.tier === 'free' ? 'Starter' : info.tier.charAt(0).toUpperCase() + info.tier.slice(1)
        const left = typeof info.daily_limit === 'number' ? ` · ${Math.max(0, info.daily_limit - info.daily_requests).toLocaleString()} of ${info.daily_limit.toLocaleString()} requests left` : ' · unlimited'
        // DARCE_DEMO=1 keeps your email out of screen recordings
        if (info.tier === 'trial') accountLine.current = `trial${left} · \`darce signup\` keeps going for free`
        else if (!process.env.DARCE_DEMO) accountLine.current = `${info.email} · ${plan}${left}`
        setSuggestOn(prev => (prev === null ? info.tier !== 'free' : prev))
      }
      clearTimeout(timer)
      finish()
    })
    return () => clearTimeout(timer)
  }, [])

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

  // @path mentions attach the file's contents to the message sent to the model
  const attachMentions = useCallback((text: string): string => {
    let budget = 60_000
    const parts: string[] = []
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const rel = m[1]!
      const abs = resolvePath(state.cwd, rel)
      try {
        if (!existsSync(abs) || !statSync(abs).isFile() || budget <= 0) continue
        let body = readFileSync(abs, 'utf-8')
        if (body.length > Math.min(30_000, budget)) body = body.slice(0, Math.min(30_000, budget)) + '\n…(truncated)'
        budget -= body.length
        readFilesRef.current.add(abs)
        parts.push(`<file path="${rel}">\n${body}\n</file>`)
      } catch {}
    }
    return parts.length ? `\n\nFiles the user attached:\n${parts.join('\n')}` : ''
  }, [state.cwd])

  const addImage = useCallback((a: Attachment) => {
    setAttachments(prev => [...prev, a])
    dispatch({ type: 'insert', text: `[Image #${a.n}] ` })
  }, [])

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

  const runQuery = useCallback(async (text: string, attachments = '', images: ImageContent[] = []) => {
    setBusy(true)
    setSuggestion(null)
    turnThreadsFrom.current = threadsRef.current.length
    const turnStarted = Date.now()
    trace('turn_start', { model: modelRef.current, mode: modeRef.current, history: messagesRef.current.length })
    commit({ kind: 'user', id: newId(), text })
    // Notes about things the user did between turns (e.g. /undo) ride along with the next message
    const notes = notesRef.current.splice(0)
    // The WHY note goes after the request: models follow a trailing instruction far more reliably
    const why = learnRef.current ? `\n\n[Note from Darce: ${WHY_NOTE}]` : ''
    const textContent = (notes.length ? `${notes.map(n => `[Note from Darce: ${n}]`).join('\n')}\n\n${text}` : text) + attachments + why
    messagesRef.current = [...messagesRef.current, {
      role: 'user',
      content: images.length ? [{ type: 'text', text: textContent }, ...images] : textContent,
    }]

    const controller = new AbortController()
    abortRef.current = controller
    setActivity({ label: 'Thinking', startedAt: Date.now() })

    if (!state.modelOverride) modelRef.current = selectModel(messagesRef.current, state.config.router)
    // Images need a model that can see; borrow a fast vision model for this task if needed
    const modelBeforeVision = modelRef.current
    const profile = getModelProfile(modelRef.current)
    if (images.length && profile && !profile.strengths.includes('vision')) {
      modelRef.current = state.config.visionModel || 'google/gemini-3.8-flash'
      commit({ kind: 'system', id: newId(), text: `${modelBeforeVision.split('/').pop()} can't see images, so ${modelRef.current.split('/').pop()} is handling this message.` })
    }
    setState(prev => ({ ...prev, currentModel: modelRef.current }))
    const costBefore = getTotalCost()
    const tokensBefore = getTotalTokens()
    const receipt: ReceiptData = { files: [], commands: 0, approvedByYou: 0, denied: 0, maxRisk: 0, redacted: 0, models: [], tokens: 0, cost: 0, ms: 0, undoable: true, stopped: false }
    const fileStats = new Map<string, { path: string; added: number; removed: number; created: boolean }>()
    const checkpointsAtStart = checkpointsRef.current?.count ?? 0
    // Voice: a line when a task turns out to be long, when something runs a while, when Darce needs you, and at the end
    const voice = voiceRef.current ? narratorRef.current : null
    const spoke = { start: false, progress: false, error: false }
    const did: string[] = []
    let lastText = ''
    const voiceContext = (extra = '') => [`User asked: "${text.slice(0, 300)}"`, did.length ? `Darce so far: ${did.slice(-8).join('; ')}` : '', extra].filter(Boolean).join('\n')
    const startVoice = voice ? setTimeout(() => { spoke.start = true; voice.say('start', voiceContext()) }, 6_000) : undefined
    let slowTool: ReturnType<typeof setTimeout> | undefined
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

    const authorize = async (call: { id: string; name: string; input: Record<string, unknown> }, origin?: string) => {
      let risk = toolRisk(call.name, call.input, state.cwd)
      receipt.maxRisk = Math.max(receipt.maxRisk, risk.level) as ReceiptData['maxRisk']
      const mode = modeRef.current
      // "Always allow" covers one plain command only, never chains like `npm install && curl …`
      const cmdText = String(call.input.command ?? '')
      const key = call.name === 'Bash' && isSimpleCommand(cmdText) ? trustKey(cmdText) : undefined
      if (risk.level === 0 || mode === 'full') return { allow: true as const }
      if (mode === 'plan') return { allow: false as const, reason: 'plan mode is on (read-only). Describe the change instead of making it.' }
      if (key && risk.level < 3 && trustedKeys(state.cwd).has(key)) return { allow: true as const, via: 'trusted' }
      // A command that runs code (npm run x, node file.js, make y) gets a second look before it runs unasked
      if (call.name === 'Bash' && risk.level === 1 && mode === 'auto' && state.config.riskCheck !== false && wantsSecondOpinion(cmdText)) {
        const second = await secondOpinion(cmdText, state.cwd, state.config.apiKey, state.config.apiBase || undefined)
        if (second && second.level > risk.level) risk = second
      }
      receipt.maxRisk = Math.max(receipt.maxRisk, risk.level) as ReceiptData['maxRisk']
      const autoOk = mode === 'auto' && risk.level <= 1 && !(taintedRef.current && call.name === 'Bash')
      if (autoOk) return { allow: true as const }

      if (Date.now() - startedAt > 10_000) notify('Darce needs approval', `${call.name} ${toolSummary(call.name, call.input)}`)
      voice?.say('ask', voiceContext(`Darce is waiting for approval to run: ${call.name === 'Bash' ? String(call.input.command ?? '') : `${call.name} ${toolSummary(call.name, call.input)}`} (${risk.reason})`))
      setActivity(null)
      return new Promise<{ allow: true; via?: string } | { allow: false; reason: string }>(resolveDecision => {
        setPending({
          req: {
            id: call.id,
            name: call.name,
            summary: (origin ? `[${origin}] ` : '') + toolSummary(call.name, call.input),
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

    // Threads started by the Agent tool: explore threads run side by side, work threads one at a time
    const spawnAgent = async (req: SpawnRequest) => {
      const t: Thread = {
        id: threadsRef.current.length + 1, title: req.description, kind: req.kind, model: modelRef.current,
        status: 'queued', activity: req.kind === 'work' ? 'waiting for its turn' : 'starting', steps: 0, cost: 0,
        startedAt: Date.now(), ms: 0, log: [], report: '',
      }
      threadsRef.current = [...threadsRef.current, t]
      bumpThreads()
      const run = () => runThread({
        thread: t, prompt: req.prompt, cwd: state.cwd, provider, passEnv: state.config.passEnv, signal: controller.signal,
        authorize: call => authorize(call, `thread ${t.id}: ${t.title}`), beforeChange, onUpdate: bumpThreads,
      })
      await (req.kind === 'work' ? workMutexRef.current.run(run) : run())
      if (t.status === 'done') return { report: t.report }
      return { report: `The thread ${t.status === 'stopped' ? 'was stopped' : `failed: ${t.error ?? 'unknown error'}`}.${t.report ? `\n\nPartial report:\n${t.report}` : ''}`, isError: true }
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
        spawnAgent,
      })

      let result = await gen.next()
      while (!result.done) {
        const event = result.value
        switch (event.type) {
          case 'request_start':
            if (receipt.models[receipt.models.length - 1] !== modelRef.current) {
              receipt.models.push(modelRef.current)
              recordModelUse(modelRef.current)
            }
            buffer = ''
            committedUpTo = 0
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            break
          case 'waiting': {
            // Keep the timer running from when we asked; just say what's happening
            const name = modelRef.current.split('/').pop()
            setActivity(a => ({ label: event.hedged ? `Waiting for ${name} · trying a faster provider` : `Waiting for ${name} to start`, startedAt: a?.startedAt ?? Date.now() }))
            break
          }
          case 'text_delta':
            buffer += event.text
            setActivity(null)
            if (!flushTimer) flushTimer = setTimeout(() => flush(false), 40)
            break
          case 'tool_use_start':
            setActivity({ label: `Preparing ${event.name}`, startedAt: Date.now() })
            break
          case 'message_complete':
            if (buffer.trim()) lastText = buffer
            flush(true)
            break
          case 'tool_executing': {
            const summary = toolSummary(event.name, event.input)
            summaries.set(event.id, summary)
            if (event.via) approvals.set(event.id, event.via === 'trusted' ? 'always allowed' : event.via)
            setActivity({ label: `${event.name} ${summary}`.trim(), startedAt: Date.now() })
            did.push(`${event.name} ${summary}`.trim())
            if (voice && event.name === 'Bash' && !spoke.progress) {
              clearTimeout(slowTool)
              slowTool = setTimeout(() => { spoke.progress = true; voice.say('progress', voiceContext(`Running for a while now: ${String(event.input.command ?? '')}`)) }, 12_000)
            }
            break
          }
          case 'tool_result_ready': {
            clearTimeout(slowTool)
            if (event.isError && event.name === 'Bash') did.push(`(that command failed: ${event.result.slice(0, 120)})`)
            // The plan is shown as a live checklist, not as a tool line
            if (event.display?.kind === 'plan') {
              setLivePlan(event.display)
              setActivity({ label: 'Thinking', startedAt: Date.now() })
              break
            }
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
            if (['WebFetch', 'WebSearch', 'StealthFetch'].includes(event.name) && !event.isError) {
              taintedRef.current = true
              setTainted(true)
            }
            setActivity({ label: 'Thinking', startedAt: Date.now() })
            break
          }
          case 'error':
            flush(true)
            commit({ kind: 'error', id: newId(), text: event.error })
            if (voice && !spoke.error) { spoke.error = true; voice.say('error', voiceContext(`It stopped with this error: ${event.error.slice(0, 300)}`)) }
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
      if (modelRef.current !== modelBeforeVision && images.length) modelRef.current = modelBeforeVision
      const took = Date.now() - startedAt
      setTitle('darce')
      setProgress('off')
      if (took >= 20_000) notify('Darce finished', text.split('\n')[0]!.slice(0, 80))
      setLivePlan(prev => {
        if (prev) commit({ kind: 'plan', id: newId(), plan: prev })
        return null
      })
      if (steps > 0) {
        // In a git repo the checkpoints know everything this turn changed, shell commands included
        const actual = checkpointsRef.current?.diffSince(checkpointsAtStart)
        receipt.files = actual
          ? actual.filter(d => d.added || d.removed || d.created).map(d => ({ path: d.path, added: d.added, removed: d.removed, created: !!d.created }))
          : [...fileStats.values()]
        receipt.tokens = getTotalTokens() - tokensBefore
        receipt.cost = getTotalCost() - costBefore
        receipt.ms = took
        receipt.undoable = checkpointsRef.current!.count > 0
        receipt.stopped = controller.signal.aborted
        commit({ kind: 'receipt', id: newId(), data: receipt })
      }
      clearTimeout(startVoice); clearTimeout(slowTool)
      if (voice) {
        if (controller.signal.aborted) voice.stop()
        else if (!spoke.error && (spoke.start || took >= 15_000)) {
          const files = receipt.files?.length ? `Files changed: ${receipt.files.map(f => `${f.path} (+${f.added} -${f.removed})`).slice(0, 6).join(', ')}.` : ''
          voice.say('done', voiceContext(`Finished. ${files}\nDarce's final message: ${(lastText || buffer).trim().slice(0, 600)}`))
        }
      }
      if (flushTimer) clearTimeout(flushTimer)
      setTail('')
      setActivity(null)
      abortRef.current = null
      setContextTokens(estimateMessagesTokens(messagesRef.current))
      if (messagesRef.current.length > 0) saveSession(state.sessionId, messagesRef.current, state.cwd)
      trace('turn_end', { ms: Date.now() - turnStarted, stopped: controller.signal.aborted })
      setBusy(false)
      if (suggestRef.current && !controller.signal.aborted) {
        const snapshot = messagesRef.current
        void predictNext(provider, state.config.suggestModel || DEFAULT_SUGGEST_MODEL, snapshot).then(guess => {
          // Only show it if nothing new happened in the meantime
          if (guess && messagesRef.current === snapshot) setSuggestion(guess)
        })
      }
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
    if (modeRef.current === 'plan') { commit({ kind: 'system', id: newId(), text: '/derby makes changes, and plan mode is read-only. Switch mode with Shift+Tab first.' }); return }
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
    await d.run(rest, messagesRef.current, provider, state.config.passEnv, modeRef.current as 'ask' | 'auto' | 'full')
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

  const startSwarm = useCallback(async (args: string) => {
    const task = args.trim()
    if (!task) { commit({ kind: 'system', id: newId(), text: 'Usage: /swarm <task>\nA lead agent splits the task into 2-4 independent parts. Each part runs as a thread in its own git worktree at the same time, then all results are merged into your files in one step (/undo reverts the lot).' }); return }
    if (modeRef.current === 'plan') { commit({ kind: 'system', id: newId(), text: '/swarm makes changes, and plan mode is read-only. Switch mode with Shift+Tab first.' }); return }
    const cps = checkpointsRef.current!
    if (!cps.gitRoot) { commit({ kind: 'system', id: newId(), text: '/swarm needs a git repository: each thread works in its own worktree.' }); return }
    commit({ kind: 'user', id: newId(), text: `/swarm ${task}` })
    setBusy(true)
    setTitle('darce · swarm')
    setActivity({ label: 'Planning the swarm', startedAt: Date.now() })
    let parts: SwarmPart[]
    try {
      parts = await planSwarm(task, provider, modelRef.current, state.cwd)
    } catch (err) {
      setActivity(null); setBusy(false); setTitle('darce')
      commit({ kind: 'system', id: newId(), text: `Couldn't plan the swarm: ${(err as Error).message}` })
      return
    }
    setActivity(null)
    commit({ kind: 'system', id: newId(), text: `Swarm plan: ${parts.length} thread${parts.length === 1 ? '' : 's'}\n${parts.map((p, i) => `  ${i + 1}. ${p.title}`).join('\n')}` })
    const base = cps.commitWorkingTree('darce swarm base')
    if (!base) { setBusy(false); setTitle('darce'); commit({ kind: 'system', id: newId(), text: 'Couldn\'t snapshot your working tree for the swarm.' }); return }
    const workers = parts.map((p, i) => ({ model: modelRef.current, task: p.prompt, title: p.title, context: laneNote(parts, i) }))
    const d = new Derby(cps.gitRoot, base, workers, () => setDerbyTick(n => n + 1))
    setDerby({ d, task, selected: 0, finished: false, variant: 'swarm' })
    setProgress('busy')
    const started = Date.now()
    await d.run(task, [], provider, state.config.passEnv, modeRef.current as 'ask' | 'auto' | 'full')
    setProgress('off')
    setTitle('darce')
    if (Date.now() - started >= 20_000) notify('Swarm finished', 'Review and merge')
    // Keep the workers in /threads
    for (const r of d.racers) {
      threadsRef.current = [...threadsRef.current, {
        id: threadsRef.current.length + 1, title: r.title ?? r.model, kind: 'swarm', model: r.model,
        status: r.status === 'starting' || r.status === 'running' ? 'stopped' : r.status, activity: r.status, steps: r.steps, cost: r.cost,
        startedAt: started, ms: r.ms, log: [], report: r.answer.trim(), error: r.error,
      }]
    }
    setDerby(prev => prev && { ...prev, finished: true })
  }, [commit, provider, state.cwd, state.config.passEnv])

  const finishSwarm = useCallback((merge: boolean) => {
    if (!derby) return
    const { d, task } = derby
    if (merge) {
      checkpointsRef.current!.snapshot(`Swarm: ${task.slice(0, 40)}`)
      const { files, merged, conflicts } = d.applyAll()
      const done = d.racers.filter(r => r.status === 'done')
      const lines = [`Merged ${done.length} thread${done.length === 1 ? '' : 's'}: ${files} file${files === 1 ? '' : 's'} changed${merged.length ? `, ${merged.length} combined from several threads` : ''}. /undo reverts the whole swarm.`]
      for (const c of conflicts) lines.push(`  ! ${c.path}: "${c.worker}" overlapped an earlier thread's edit; the earlier version was kept.`)
      commit({ kind: 'system', id: newId(), text: lines.join('\n') })
      for (const r of done) for (const diff of r.diffs) commit({ kind: 'expanded', id: newId(), name: r.title ?? 'changed', summary: diff.path, result: '', display: diff })
      const report = d.racers.map(r => `## ${r.title}\n${r.answer.trim() || `(${r.status}${r.error ? `: ${r.error}` : ''})`}`).join('\n\n')
      messagesRef.current = [
        ...messagesRef.current,
        { role: 'user', content: `/swarm ${task}` },
        { role: 'assistant', content: `The swarm finished and its changes are merged into the working tree.\n\n${report}${conflicts.length ? `\n\nOverlapping edits not merged: ${conflicts.map(c => c.path).join(', ')}` : ''}` },
      ]
      setContextTokens(estimateMessagesTokens(messagesRef.current))
    } else {
      d.stop()
      commit({ kind: 'system', id: newId(), text: 'Swarm discarded. Your files were not changed.' })
    }
    d.cleanup()
    setDerby(null)
    setBusy(false)
  }, [derby, commit])

  const resumeSession = useCallback((summary: SessionSummary) => {
    setShowSessions(false)
    const loaded = loadSession(summary.sessionId)
    if (!loaded) { commit({ kind: 'system', id: newId(), text: 'Couldn\'t open that conversation; its file may have been removed.' }); return }
    // Continue in the same session file, so the conversation keeps growing in one place
    messagesRef.current = loaded.messages
    setState(prev => ({ ...prev, sessionId: loaded.sessionId }))
    provider.setSession?.(loaded.sessionId)
    commit({ kind: 'system', id: newId(), text: `── Resuming "${summary.title}" ──` })
    for (const item of itemsFromMessages(loaded.messages)) commit(item)
    const elsewhere = loaded.cwd && loaded.cwd !== state.cwd
    commit({ kind: 'system', id: newId(), text: `Resumed ${loaded.messages.length} messages.${elsewhere ? ` This conversation started in ${loaded.cwd}; Darce is working in ${state.cwd}, so file paths may differ.` : ''} Carry on where you left off.` })
    setContextTokens(estimateMessagesTokens(loaded.messages))
    trace('resume', { messages: loaded.messages.length, elsewhere: !!elsewhere })
  }, [commit, setState, state.cwd, provider])

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
    if (result === '__COMMUNITY__') {
      commit({ kind: 'user', id: newId(), text })
      openInBrowser(DISCORD_URL)
      commit({ kind: 'system', id: newId(), text: `Opening the Darce Discord: ${DISCORD_URL}\nAsk for help, share what you built, and tell us what to fix.` })
      return
    }
    const useAccount = (apiKey: string, apiBase?: string) => {
      provider.setCredentials?.(apiKey, apiBase)
      setState(prev => ({ ...prev, config: { ...prev.config, apiKey, apiBase: apiBase ?? prev.config.apiBase } }))
    }
    const describe = async (apiKey: string, apiBase?: string) => {
      const info = await fetchAccount(apiKey, apiBase)
      if (!info) return ''
      const limit = typeof info.daily_limit === 'string' ? 'unlimited' : `${info.daily_requests}/${info.daily_limit} requests used`
      const plan = info.tier === 'free' ? 'Starter (free)' : info.tier.charAt(0).toUpperCase() + info.tier.slice(1)
      return `${plan} plan · ${limit}`
    }
    if (result === '__LOGIN__') {
      commit({ kind: 'user', id: newId(), text })
      commit({ kind: 'system', id: newId(), text: 'Opening cli.darce.dev in your browser to sign in…' })
      void browserLogin({ onUrl: url => commit({ kind: 'system', id: newId(), text: `If it didn't open, visit:\n${url}` }) })
        .then(async r => {
          const acct = addAccount(r.email, r.apiKey, state.config.apiBase || undefined)
          useAccount(acct.apiKey, acct.apiBase)
          commit({ kind: 'system', id: newId(), text: `Signed in as ${acct.email}. ${await describe(acct.apiKey, acct.apiBase)}` })
        })
        .catch(err => commit({ kind: 'error', id: newId(), text: (err as Error).message }))
      return
    }
    if (result === '__LOGOUT__') {
      commit({ kind: 'user', id: newId(), text })
      const r = removeAccount()
      if (r.nowActive) {
        useAccount(r.nowActive.apiKey, r.nowActive.apiBase)
        commit({ kind: 'system', id: newId(), text: `Signed out${r.removed ? ` of ${r.removed}` : ''}. Now using ${r.nowActive.email}.` })
      } else {
        useAccount('')
        commit({ kind: 'system', id: newId(), text: 'Signed out. Run /login to sign in again.' })
      }
      return
    }
    if (result?.startsWith('__ACCOUNT__:')) {
      commit({ kind: 'user', id: newId(), text })
      const arg = result.slice(12)
      if (arg.startsWith('switch')) {
        const who = arg.slice(6).trim()
        const acct = who ? switchAccount(who) : null
        if (!acct) { commit({ kind: 'system', id: newId(), text: who ? `No saved account matches "${who}". Use /login to add one.` : 'Usage: /account switch <email>' }); return }
        useAccount(acct.apiKey, acct.apiBase)
        void describe(acct.apiKey, acct.apiBase).then(d => commit({ kind: 'system', id: newId(), text: `Switched to ${acct.email}. ${d}` }))
        return
      }
      const { active, accounts } = listAccounts()
      void describe(state.config.apiKey, state.config.apiBase || undefined).then(d => {
        const lines = [
          active ? `Signed in as ${active}${d ? ` — ${d}` : ''}` : `Signed in${d ? ` — ${d}` : ' (account details unavailable)'}`,
          accounts.length > 1 ? `\nSaved accounts:\n${accounts.map(a => `  ${a.email === active ? '●' : '○'} ${a.email}`).join('\n')}\nSwitch with /account switch <email>.` : '',
          '\n/login adds another account · /logout signs out · /upgrade changes your plan · dashboard: https://cli.darce.dev/dashboard',
        ]
        commit({ kind: 'system', id: newId(), text: lines.filter(Boolean).join('\n') })
      })
      return
    }
    if (result?.startsWith('__MEMORY__:')) {
      commit({ kind: 'user', id: newId(), text })
      const arg = result.slice(11)
      if (arg.startsWith('forget ')) {
        const what = arg.slice(7)
        const n = forget('user', state.cwd, what) + forget('project', state.cwd, what)
        resetContext()
        commit({ kind: 'system', id: newId(), text: n ? `Forgot ${n} note${n === 1 ? '' : 's'} matching "${what}".` : `Nothing in memory matches "${what}".` })
        return
      }
      const show = (scope: 'user' | 'project', title: string) => {
        const notes = readMemory(scope, state.cwd).split('\n').filter(l => l.startsWith('- '))
        return `${title} (${memoryPath(scope, state.cwd).replace(homedir(), '~')})\n${notes.length ? notes.map(n => `  ${n}`).join('\n') : '  nothing yet'}`
      }
      commit({ kind: 'system', id: newId(), text: `${show('user', 'About you')}\n\n${show('project', 'About this project')}\n\nDarce adds notes when you correct it or share a preference. Edit the files freely, or /memory forget <text>.` })
      return
    }
    if (result === '__SKILLS__') {
      commit({ kind: 'user', id: newId(), text })
      const skills = discoverSkills(state.cwd)
      const label: Record<string, string> = { project: 'project', user: '~/.darce', claude: '~/.claude', plugin: 'plugin', builtin: 'built-in' }
      commit({ kind: 'system', id: newId(), text: `${skills.length} skills — Darce loads one automatically when your task matches it:\n${skills.map(s => `  ${s.name}  (${label[s.source]})\n    ${s.description.slice(0, 140)}`).join('\n')}\n\nAdd your own: ~/.darce/skills/<name>/SKILL.md (or .darce/skills in a project). Claude Code skills work as-is.` })
      return
    }
    if (result?.startsWith('__SECURITY__:')) {
      const target = result.slice(13)
      void runQuery(target.startsWith('change')
        ? 'Load the security-review skill and review my uncommitted changes (git diff, including untracked files). Report findings by severity with proof and fixes. Do not change any code.'
        : `Load the security-review skill and do a security review of this project${target ? ` focusing on ${target}` : ''}. Report findings by severity with proof and fixes. Do not change any code.`)
      return
    }
    if (result?.startsWith('__SUGGEST__:')) {
      const arg = result.slice(12)
      const on = arg === 'on' ? true : arg === 'off' ? false : !suggestOn
      setSuggestOn(on)
      if (!on) setSuggestion(null)
      commit({ kind: 'system', id: newId(), text: on
        ? `Next-step suggestions on: after each task, ${(state.config.suggestModel || DEFAULT_SUGGEST_MODEL).split('/').pop()} predicts what you'll ask next. Tab accepts. Each prediction is one small request.`
        : 'Next-step suggestions off.' })
      return
    }
    if (result?.startsWith('__VOICE__:')) {
      const arg = result.slice(10).trim()
      const lower = arg.toLowerCase()
      const narrator = narratorRef.current!
      narrator.onLimit = message => { commit({ kind: 'system', id: newId(), text: `Voice: ${message}` }); setVoiceOn(false); saveGlobalSetting('voice', false) }
      if (lower.startsWith('name ')) {
        voiceNameRef.current = arg.slice(5).trim().slice(0, 24)
        saveGlobalSetting('voiceName', voiceNameRef.current)
        commit({ kind: 'system', id: newId(), text: voiceNameRef.current ? `Darce will call you ${voiceNameRef.current}.` : 'Darce won\'t use your name.' })
        return
      }
      const pick = (VOICE_NAMES as readonly string[]).includes(lower) ? lower : null
      if (pick) { voiceIdRef.current = pick; saveGlobalSetting('voiceId', pick) }
      const on = pick ? true : lower === 'on' ? true : lower === 'off' ? false : !voiceOn
      setVoiceOn(on)
      saveGlobalSetting('voice', on)
      if (!on) { narrator.stop(); commit({ kind: 'system', id: newId(), text: 'Voice off. Turn it back on with /voice on.' }); return }
      if (!findPlayer()) {
        commit({ kind: 'system', id: newId(), text: process.platform === 'linux' ? 'Voice is on, but there\'s no audio player to play it with. Install one, for example: sudo apt install mpg123' : 'Voice is on, but no audio player was found on this machine.' })
        return
      }
      commit({ kind: 'system', id: newId(), text: `Voice on (${voiceIdRef.current}${voiceNameRef.current ? `, calling you ${voiceNameRef.current}` : ''}). Darce speaks up when a task runs long, when it needs you, and when it's done. Quick tasks stay quiet. Voices: ${VOICE_NAMES.join(', ')} · /voice name <first name> · /voice off` })
      narrator.say('hello', 'The developer just switched voice on.')
      return
    }
    if (result?.startsWith('__LEARN__:')) {
      const arg = result.slice(10)
      const on = arg === 'on' ? true : arg === 'off' ? false : !learnOn
      setLearnOn(on)
      saveGlobalSetting('why', on)
      commit({ kind: 'system', id: newId(), text: on ? 'WHY on: when a change involves a concept or pitfall worth knowing, Darce ends with a short WHY note. Routine changes get none.' : 'WHY off. Turn it back on with /why on.' })
      return
    }
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
    if (result?.startsWith('__SWARM__:')) { void startSwarm(result.slice(10)); return }
    if (result?.startsWith('__RESUME__:')) {
      if (busy) { flashHint('Wait for Darce to finish (or Esc), then /resume.'); return }
      setShowSessions(true)
      return
    }
    if (result?.startsWith('__DEBUG__:')) {
      commit({ kind: 'system', id: newId(), text: `Timing log for this session (newest last). Full log: ~/.darce/logs/trace.log\n\n${recentTrace(40)}` })
      return
    }
    if (result?.startsWith('__THREADS__:')) {
      const all = threadsRef.current
      const n = parseInt(result.slice(12), 10)
      if (!all.length) { commit({ kind: 'system', id: newId(), text: 'No threads yet. Darce starts threads on its own for parallel research, or use /swarm <task>.' }); return }
      const th = all[n - 1]
      if (n && th) {
        const head = `Thread ${th.id}: ${th.title}\n${th.kind} · ${th.model} · ${th.status} · ${th.steps} steps · ${Math.round(th.ms / 1000)}s · $${th.cost.toFixed(4)}`
        const log = th.log.length ? `\n\nSteps:\n${th.log.slice(-15).map(l => `  ${l}`).join('\n')}` : ''
        commit({ kind: 'system', id: newId(), text: `${head}${log}\n\nReport:\n${th.report || th.error || '(none)'}` })
        return
      }
      const icon = (s: Thread['status']) => (s === 'done' ? '✓' : s === 'error' ? '✗' : s === 'stopped' ? '■' : '…')
      commit({ kind: 'system', id: newId(), text: `Threads this session\n${all.map(t => `  ${String(t.id).padStart(2)} ${icon(t.status)} ${t.title.padEnd(34).slice(0, 34)} ${t.kind.padEnd(8)} ${t.steps} steps · ${Math.round(t.ms / 1000)}s · $${t.cost.toFixed(4)}`).join('\n')}\n/threads <number> shows a thread's steps and report.` })
      return
    }
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
  }, [state.currentModel, state.cwd, state.mode, state.config.criticModel, state.config.suggestModel, setState, exit, clearScreen, commit, openTape, startDerby, startSwarm, busy, criticOn, learnOn, suggestOn, runQuery])

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
    if (initialPrompt && introDone && !startedInitial.current) {
      startedInitial.current = true
      void runQuery(initialPrompt)
    }
  }, [initialPrompt, introDone, runQuery])

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
        if (derby.variant === 'swarm') {
          if (derby.d.racers.some(r => r.status === 'done' && r.diffs.length)) finishSwarm(true)
          else flashHint('No thread made changes. Esc to close.')
          return
        }
        const r = derby.d.racers[derby.selected]!
        if (r.diffs.length) finishDerby(derby.selected)
        else flashHint('That model made no changes. Pick another, or Esc to discard.')
      } else if (key.escape || (key.ctrl && input === 'c')) (derby.variant === 'swarm' ? finishSwarm(false) : finishDerby(null))
      return
    }
    if (search) {
      if (key.return) {
        const match = historyMatches[search.skip]
        if (match) dispatch({ type: 'set', text: match })
        setSearch(null)
      } else if (key.escape || (key.ctrl && input === 'c')) setSearch(null)
      else if (key.ctrl && input === 'r') setSearch({ ...search, skip: Math.min(search.skip + 1, Math.max(0, historyMatches.length - 1)) })
      else if (key.backspace || key.delete) setSearch({ query: search.query.slice(0, -1), skip: 0 })
      else if (input && !key.ctrl && !key.meta) setSearch({ query: search.query + input, skip: 0 })
      return
    }
    if (completion && completion.items.length && !pending) {
      const n = completion.items.length
      const item = completion.items[Math.min(menuIndex, n - 1)]!
      if (key.upArrow) { setMenuIndex(i => (i - 1 + n) % n); return }
      if (key.downArrow) { setMenuIndex(i => (i + 1) % n); return }
      if (key.escape) { setMenuDismissed(editor.text); return }
      if (key.tab || (key.return && !key.shift)) {
        const { start, end } = completion.ctx
        if (key.return && completion.ctx.kind === 'command' && !item.args) {
          // Run the highlighted command straight away
          dispatch({ type: 'clear' })
          if (busy && !/^\/(help|cost)\b/.test(item.value)) { flashHint('Wait for Darce to finish, or press Esc to stop it'); return }
          handleCommand(item.value)
          return
        }
        dispatch({ type: 'replace', start, end, text: `${item.value} ` })
        return
      }
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
    if (suggestion && !editor.text && (key.tab || key.rightArrow)) {
      dispatch({ type: 'set', text: suggestion })
      setSuggestion(null)
      return
    }
    if (suggestion && input && !key.ctrl && !key.meta) setSuggestion(null)
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
      case 'pasteImage':
        void clipboardImage(imageCounter.current + 1).then(r => {
          if ('error' in r) { flashHint(r.error, 3500); return }
          imageCounter.current = r.n
          addImage(r)
        })
        return
      case 'historySearch':
        if (editor.history.length) setSearch({ query: '', skip: 0 })
        return
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
        const used = attachments.filter(a => text.includes(`[Image #${a.n}]`))
        const images: ImageContent[] = used.map(a => ({ type: 'image', mediaType: a.mediaType, data: toBase64(a), name: a.name }))
        setAttachments([])
        void runQuery(text, attachMentions(text), images)
        return
      }
      case 'edit':
        dispatch(intent.action)
        return
    }
  }, { isActive: !showPicker && !showSessions })

  usePaste(text => {
    // Dragging image files into the terminal pastes their paths — turn them into attachments
    const tokens = text.trim().match(/'[^']+'|"[^"]+"|(?:\\ |[^\s])+/g) ?? []
    const paths = tokens.map(tok => imagePathFrom(tok, state.cwd))
    if (tokens.length > 0 && paths.every(Boolean)) {
      for (const p of paths) {
        const a = attachmentFromFile(p!, imageCounter.current + 1)
        if ('error' in a) { flashHint(a.error, 3500); continue }
        imageCounter.current = a.n
        addImage(a)
      }
      return
    }
    dispatch({ type: 'insert', text })
  }, { isActive: !showPicker && !showSessions && !pending && !tape && !derby })

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
        {!introDone ? <Intro onDone={finishIntro} ready={accountReady} /> : null}
        {tail ? (
          <Box marginBottom={1}>
            <Markdown text={closeOpenFence(tail)} />
          </Box>
        ) : null}

        {livePlan ? <PlanPanel plan={livePlan} live={busy} /> : null}
        {busy && threadsRef.current.length > turnThreadsFrom.current ? <ThreadsPanel threads={threadsRef.current.slice(turnThreadsFrom.current)} /> : null}

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
        {derby ? <DerbyBoard task={derby.task} racers={derby.d.racers} selected={derby.selected} finished={derby.finished} variant={derby.variant} /> : null}

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

        {showSessions && (
          <SessionPicker
            cwd={state.cwd}
            currentSessionId={state.sessionId}
            onSelect={resumeSession}
            onClose={() => setShowSessions(false)}
          />
        )}

        <Prompt editor={editor} busy={busy} dimmed={showPicker || showSessions || !!pending || !!tape || !!derby} suggestion={suggestion} />
        {attachments.filter(a => editor.text.includes(`[Image #${a.n}]`)).map(a => (
          <Text key={a.n} color={t.faint}>
            {'  '}<Text color={t.accent}>▣</Text> Image #{a.n}  {a.name}{a.width ? `  ${a.width}×${a.height}` : ''}  {Math.round(a.bytes / 1024)} KB
          </Text>
        ))}
        {search ? (
          <Text>
            <Text color={t.faint}>  history search </Text><Text color={t.accent}>{search.query || ' '}</Text>
            <Text color={t.faint}>  {historyMatches[search.skip] ? `→ ${historyMatches[search.skip]!.split('\n')[0]}` : 'no match'}   enter use · ctrl+r older · esc cancel</Text>
          </Text>
        ) : completion && !pending && !tape && !derby ? (
          <CompletionMenu items={completion.items as MenuItem[]} selected={Math.min(menuIndex, completion.items.length - 1)} title={completion.ctx.kind === 'file' ? 'tab inserts the file · it is attached to your message' : undefined} />
        ) : null}
        <StatusBar
          model={state.currentModel}
          cwd={state.cwd}
          contextTokens={contextTokens}
          hint={hint}
          mode={state.mode}
          tainted={tainted}
          gear={{ index: gearIndex(gears, state.currentModel), total: gears.length }}
          critic={criticOn}
          learn={learnOn}
          voice={voiceOn}
        />
      </Box>
    </>
  )
}
