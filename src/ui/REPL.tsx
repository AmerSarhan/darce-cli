import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { Messages } from './Messages.js'
import { Prompt } from './Prompt.js'
import { Spinner } from './Spinner.js'
import { StatusBar } from './StatusBar.js'
import { ModelPicker } from './ModelPicker.js'
import { useAppState } from './App.js'
import { query } from '../core/query.js'
import { buildSystemPrompt } from '../core/context.js'
import { selectModel } from '../providers/router.js'
import type { Message as MessageType, SpinnerMode } from '../types.js'
import type { Provider } from '../providers/provider.js'

type Props = {
  provider: Provider
  initialPrompt?: string
}

export function REPL({ provider, initialPrompt }: Props) {
  const { state, setState } = useAppState()
  const { exit } = useApp()

  const [messages, setMessages] = useState<MessageType[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [spinnerMode, setSpinnerMode] = useState<SpinnerMode>('idle')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const readFilesRef = useRef(new Set<string>())
  const abortRef = useRef<AbortController | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const processedInitialPrompt = useRef(false)

  const isLoading = spinnerMode !== 'idle'

  // Handle Ctrl+C and Ctrl+M
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
      return
    }
  })

  const handleSubmit = useCallback(async (userInput: string) => {
    if (isProcessing) return

    setIsProcessing(true)
    setHistory(prev => [userInput, ...prev])

    const userMessage: MessageType = { role: 'user', content: userInput }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setSpinnerMode('requesting')

    const abortController = new AbortController()
    abortRef.current = abortController

    const model = state.modelOverride || selectModel(newMessages, state.config.router)
    setState(prev => ({ ...prev, currentModel: model }))

    try {
      const gen = query({
        messages: newMessages,
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
            setSpinnerMode('requesting')
            break
          case 'text_delta':
            setStreamingText(prev => (prev ?? '') + event.text)
            setSpinnerMode('responding')
            break
          case 'tool_use_start':
            setSpinnerMode('tool-use')
            break
          case 'tool_use_end':
            setSpinnerMode('tool-use')
            break
          case 'message_complete':
            setStreamingText(null)
            // Don't add to messages here — query loop manages the full array
            // and we set it from result.value.messages at the end
            break
          case 'error':
            setStreamingText(null)
            setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${event.error}` }])
            break
        }

        result = await gen.next()
      }

      // Query finished — update messages with final state
      if (result.value) {
        setMessages(result.value.messages)
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
    } finally {
      setSpinnerMode('idle')
      setStreamingText(null)
      abortRef.current = null
      setIsProcessing(false)
    }
  }, [messages, state, provider, isProcessing])

  // Handle initial prompt
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
        <Text bold color="white">╭ </Text>
        <Text bold color="cyan">Darce</Text>
        <Text dimColor> v0.1.0</Text>
        <Text dimColor> ({(state.currentModel.split('/').pop() || state.currentModel)})</Text>
      </Box>

      {/* Messages + streaming */}
      <Messages messages={messages} streamingText={streamingText} />

      {/* Spinner */}
      <Spinner mode={spinnerMode} />

      {/* Model picker overlay */}
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
      <StatusBar model={state.currentModel} cwd={state.cwd} />
    </Box>
  )
}
