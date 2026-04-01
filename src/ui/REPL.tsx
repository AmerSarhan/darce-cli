import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { Prompt } from './Prompt.js'
import { StatusBar } from './StatusBar.js'
import { ModelPicker } from './ModelPicker.js'
import { Markdown } from './Markdown.js'
import { useAppState } from './App.js'
import { query } from '../core/query.js'
import { buildSystemPrompt } from '../core/context.js'
import { selectModel } from '../providers/router.js'
import { isSlashCommand, executeCommand } from '../core/commands.js'
import { saveSession } from '../state/sessions.js'
import type { CommandContext } from '../core/commands.js'
import type { SpinnerMode } from '../types.js'
import type { Provider } from '../providers/provider.js'

// Each item in the display log
type DisplayItem =
  | { type: 'user'; text: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-call'; name: string; summary: string }
  | { type: 'tool-result'; name: string; result: string; isError?: boolean }
  | { type: 'system'; text: string }

type Props = {
  provider: Provider
  initialPrompt?: string
}

export function REPL({ provider, initialPrompt }: Props) {
  const { state, setState } = useAppState()
  const { exit } = useApp()

  const [displayLog, setDisplayLog] = useState<DisplayItem[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [spinnerMode, setSpinnerMode] = useState<SpinnerMode>('idle')
  const [spinnerLabel, setSpinnerLabel] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const readFilesRef = useRef(new Set<string>())
  const abortRef = useRef<AbortController | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const messagesRef = useRef<any[]>([])
  const processedInitialPrompt = useRef(false)

  const isLoading = spinnerMode !== 'idle'

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
        setSpinnerMode('idle')
        setStreamingText(null)
        setIsProcessing(false)
      } else {
        exit()
      }
      return
    }
    if (key.ctrl && ch === 'm' && !isLoading) {
      setShowModelPicker(true)
    }
  })

  const handleSubmit = useCallback(async (userInput: string) => {
    if (isProcessing) return

    // Handle slash commands locally
    if (isSlashCommand(userInput)) {
      setHistory(prev => [userInput, ...prev])

      const cmdContext: CommandContext = {
        setModel: (model: string) => {
          setState(prev => ({ ...prev, modelOverride: model, currentModel: model }))
        },
        currentModel: state.currentModel,
        clearMessages: () => {
          // For /compact, keep last 4 messages; for /clear, clear all
          if (userInput.trim().startsWith('/compact')) {
            messagesRef.current = messagesRef.current.slice(-4)
          } else {
            messagesRef.current = []
          }
        },
        cwd: state.cwd,
      }

      const result = executeCommand(userInput, cmdContext)

      if (result === '__QUIT__') {
        exit()
        return
      }

      if (userInput.trim().startsWith('/clear') || userInput.trim().startsWith('/c ') || userInput.trim() === '/c') {
        setDisplayLog([])
      }

      if (result) {
        setDisplayLog(prev => [...prev, { type: 'system', text: result }])
      }
      return
    }

    setIsProcessing(true)
    setHistory(prev => [userInput, ...prev])

    // Add user message to display
    setDisplayLog(prev => [...prev, { type: 'user', text: userInput }])

    const userMessage = { role: 'user' as const, content: userInput }
    messagesRef.current = [...messagesRef.current, userMessage]

    setSpinnerMode('requesting')
    setSpinnerLabel('Thinking')

    const abortController = new AbortController()
    abortRef.current = abortController

    const model = state.modelOverride || selectModel(messagesRef.current, state.config.router)
    setState(prev => ({ ...prev, currentModel: model }))

    let currentAssistantText = ''

    try {
      const gen = query({
        messages: messagesRef.current,
        model,
        provider,
        cwd: state.cwd,
        systemPrompt: buildSystemPrompt(state.cwd),
        maxTurns: state.config.maxTurns,
        readFiles: readFilesRef.current,
        abortSignal: abortController.signal,
      })

      let result = await gen.next()
      while (!result.done) {
        const event = result.value

        switch (event.type) {
          case 'request_start':
            // New turn starting (after tool results sent back)
            currentAssistantText = ''
            setStreamingText(null)
            setSpinnerMode('requesting')
            setSpinnerLabel('Thinking')
            break

          case 'text_delta':
            currentAssistantText += event.text
            // Show only complete lines
            const visible = currentAssistantText.substring(0, currentAssistantText.lastIndexOf('\n') + 1) || null
            setStreamingText(visible)
            setSpinnerMode('responding')
            setSpinnerLabel('')
            break

          case 'tool_use_start':
            setSpinnerMode('tool-input')
            setSpinnerLabel(`${event.name}`)
            break

          case 'message_complete':
            // Flush any remaining streaming text as a display item
            if (currentAssistantText.trim()) {
              setDisplayLog(prev => [...prev, { type: 'assistant-text', text: currentAssistantText }])
            }
            setStreamingText(null)
            currentAssistantText = ''
            break

          case 'tool_executing':
            setSpinnerMode('tool-use')
            setSpinnerLabel(`${event.name} ${toolSummary(event.name, event.input)}`)
            // Show tool call in display
            setDisplayLog(prev => [...prev, {
              type: 'tool-call',
              name: event.name,
              summary: toolSummary(event.name, event.input),
            }])
            break

          case 'tool_result_ready':
            // Show result
            setDisplayLog(prev => [...prev, {
              type: 'tool-result',
              name: event.name,
              result: event.result,
              isError: event.isError,
            }])
            setSpinnerMode('requesting')
            setSpinnerLabel('Thinking')
            break

          case 'error':
            setStreamingText(null)
            setDisplayLog(prev => [...prev, { type: 'assistant-text', text: `Error: ${event.error}` }])
            break
        }

        result = await gen.next()
      }

      // Update messages ref with final state
      if (result.value) {
        messagesRef.current = result.value.messages
      }
    } catch (err: any) {
      setDisplayLog(prev => [...prev, { type: 'assistant-text', text: `Error: ${err.message}` }])
    } finally {
      setSpinnerMode('idle')
      setSpinnerLabel('')
      setStreamingText(null)
      abortRef.current = null
      setIsProcessing(false)
      // Persist session after each query completes
      if (messagesRef.current.length > 0) {
        saveSession(state.sessionId, messagesRef.current, state.cwd)
      }
    }
  }, [state, provider, isProcessing])

  React.useEffect(() => {
    if (initialPrompt && !processedInitialPrompt.current) {
      processedInitialPrompt.current = true
      handleSubmit(initialPrompt)
    }
  }, [initialPrompt])

  const handleModelSelect = useCallback((model: string) => {
    setState(prev => ({ ...prev, modelOverride: model, currentModel: model }))
    setShowModelPicker(false)
  }, [])

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{'> '}</Text>
        <Text bold>Darce</Text>
        <Text dimColor> v0.2.2 </Text>
        <Text dimColor>({state.currentModel.split('/').pop() || state.currentModel})</Text>
      </Box>

      {/* Display log — everything that happened */}
      {displayLog.map((item, i) => (
        <DisplayItemView key={i} item={item} />
      ))}

      {/* Streaming text preview */}
      {streamingText && (
        <Box marginBottom={1} marginLeft={0}>
          <Markdown text={streamingText} />
        </Box>
      )}

      {/* Spinner */}
      {spinnerMode !== 'idle' && spinnerMode !== 'responding' && (
        <SpinnerView mode={spinnerMode} label={spinnerLabel} />
      )}

      {/* Model picker */}
      {showModelPicker && (
        <ModelPicker
          currentModel={state.currentModel}
          onSelect={handleModelSelect}
          onClose={() => setShowModelPicker(false)}
        />
      )}

      {/* Input prompt */}
      <Prompt onSubmit={handleSubmit} isLoading={isLoading} history={history} />

      {/* Status bar */}
      <StatusBar model={state.currentModel} cwd={state.cwd} messages={messagesRef.current} />
    </Box>
  )
}

// === Display Items ===

function DisplayItemView({ item }: { item: DisplayItem }) {
  switch (item.type) {
    case 'user':
      return (
        <Box marginBottom={1}>
          <Text bold color="magenta">{'> '}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      )
    case 'assistant-text':
      return (
        <Box marginBottom={1}>
          <Markdown text={item.text} />
        </Box>
      )
    case 'tool-call': {
      const safe = ['Read', 'Glob', 'Grep', 'WebFetch'].includes(item.name)
      return (
        <Box marginLeft={1}>
          <Text color={safe ? 'gray' : 'yellow'} bold>{safe ? '○' : '●'} </Text>
          <Text color="cyan" bold>{item.name} </Text>
          <Text dimColor>{item.summary}</Text>
        </Box>
      )
    }
    case 'tool-result': {
      const lines = item.result.split('\n')
      const preview = lines.length > 10
        ? [...lines.slice(0, 8), `  ... ${lines.length - 8} more lines`].join('\n')
        : item.result
      const short = preview.length > 1000 ? preview.slice(0, 1000) + '...' : preview
      return (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {item.isError ? (
            <Text color="yellow">↻ {item.name} failed — model will retry</Text>
          ) : (
            <Text dimColor>{short}</Text>
          )}
        </Box>
      )
    }
    case 'system':
      return (
        <Box marginBottom={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      )
  }
}

// === Spinner ===

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function SpinnerView({ mode, label }: { mode: SpinnerMode; label: string }) {
  const [frame, setFrame] = React.useState(0)

  React.useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box>
      <Text color="cyan">{FRAMES[frame]} </Text>
      <Text dimColor>{label || mode}</Text>
    </Box>
  )
}

// === Tool Summary (Claude Code style — show the key info) ===

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return String(input.description || input.command || '').slice(0, 80)
    case 'Read': return String(input.file_path || '')
    case 'Write': return String(input.file_path || '')
    case 'Edit': return String(input.file_path || '')
    case 'Glob': return String(input.pattern || '')
    case 'Grep': return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`
    case 'WebFetch': return String(input.url || '')
    default: return ''
  }
}
