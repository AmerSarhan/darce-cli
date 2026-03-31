# Darce CLI Agent — Design Spec

**Date:** 2026-03-31
**Project:** darce — a blazing-fast CLI coding agent powered by OpenRouter
**Domain:** darce.dev
**Stack:** TypeScript, Ink (React for terminal), OpenRouter API, Zod

---

## 1. Vision

A general-purpose interactive CLI coding agent in the spirit of Claude Code, but powered by any model via OpenRouter. Smart model routing picks the best model for each task. Ships as a single `npm install -g darce` command.

**Non-negotiable: speed.** Every design decision optimizes for perceived and actual performance.

---

## 2. Architecture Overview

```
darce/
├── src/
│   ├── entrypoints/
│   │   └── cli.tsx              # Arg parsing, fast-path exits, dynamic import main
│   │
│   ├── main.tsx                 # Boot: config → validate → register tools → render
│   │
│   ├── ui/                      # Ink React components
│   │   ├── App.tsx              # Root: ThemeProvider → AppStateProvider → children
│   │   ├── REPL.tsx             # Main loop: messages + streamingText + prompt
│   │   ├── Messages.tsx         # Renders message list + streaming preview
│   │   ├── Message.tsx          # Dispatches to AssistantText/ToolUse/UserText
│   │   ├── AssistantTextMessage.tsx
│   │   ├── ToolUseMessage.tsx
│   │   ├── UserTextMessage.tsx
│   │   ├── Prompt.tsx           # Input with history (up-arrow), multiline
│   │   ├── Markdown.tsx         # Terminal markdown renderer
│   │   ├── CodeBlock.tsx        # Syntax-highlighted code blocks
│   │   ├── Spinner.tsx          # States: thinking/responding/tool-input
│   │   ├── StatusBar.tsx        # Model, tokens, cost, cwd
│   │   └── ModelPicker.tsx      # Ctrl+M overlay for model switching
│   │
│   ├── core/
│   │   ├── query.ts             # Async generator conversation loop
│   │   ├── conversation.ts      # Message array management, compaction
│   │   ├── context.ts           # System/user context (memoized per session)
│   │   └── streaming.ts         # SSE frame parser for OpenRouter
│   │
│   ├── providers/
│   │   ├── provider.ts          # Interface: stream(), complete(), listModels()
│   │   ├── openrouter.ts        # OpenRouter REST + SSE streaming
│   │   └── router.ts            # Smart model selection (task → best model)
│   │
│   ├── tools/
│   │   ├── Tool.ts              # Base type: name, inputSchema, call(), formatResult()
│   │   ├── registry.ts          # Register, lookup, dispatch, toAPITools()
│   │   ├── BashTool.ts          # Shell execution with streaming progress
│   │   ├── ReadTool.ts          # File read with line numbers
│   │   ├── WriteTool.ts         # Create new files
│   │   ├── EditTool.ts          # String replacement with validation
│   │   ├── GlobTool.ts          # File pattern matching (globby)
│   │   ├── GrepTool.ts          # Content search (ripgrep subprocess)
│   │   └── WebFetchTool.ts      # HTTP fetch
│   │
│   ├── config/
│   │   ├── config.ts            # Layered: ~/.darcerc → ./.darcerc → env vars
│   │   ├── models.ts            # Model profiles: capabilities, pricing, context
│   │   └── themes.ts            # Terminal color themes
│   │
│   ├── state/
│   │   ├── appState.ts          # React context for global app state
│   │   └── costTracker.ts       # Per-model token/cost accumulation
│   │
│   └── utils/
│       ├── tokens.ts            # Fast token estimation (chars/4) + exact from API
│       ├── cost.ts              # Cost calculation per model from usage response
│       ├── messages.ts          # handleMessageFromStream: SSE delta → state updates
│       └── logger.ts            # Debug logging (DARCE_DEBUG=1)
│
├── .darcerc.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 3. Core Conversation Loop

The heart of Darce. An async generator that yields stream events and messages, consumed by the REPL UI.

**Pattern (from Claude Code's query.ts):**

```typescript
async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message> {
  let state = { messages: params.messages, turnCount: 1 }

  while (true) {
    // 1. Stream from OpenRouter
    yield { type: 'request_start' }
    for await (const event of provider.stream(state.messages, model, tools)) {
      yield event  // UI consumes text_delta, tool_use_start, etc.
    }

    // 2. Execute tools (if any tool_use blocks received)
    if (toolUseBlocks.length === 0) return { reason: 'completed' }

    // Concurrent execution for read-only + concurrency-safe tools
    const results = await executeTools(toolUseBlocks, context)
    for (const result of results) yield { type: 'tool_result', data: result }

    // 3. Append and continue
    state = {
      messages: [...state.messages, ...assistantMessages, ...results],
      turnCount: state.turnCount + 1,
    }
  }
}
```

**REPL consumption:**
- `text_delta` → updates `streamingText` state (line-by-line, shows only up to last `\n`)
- `message_complete` → clears `streamingText` + appends final message (atomic, no flicker)
- `tool_result` → appends to messages
- Spinner tracks: `requesting` → `thinking` → `responding` → `tool-input`

---

## 4. Tool System

Each tool follows a uniform contract:

```typescript
type ToolDef<Input extends z.ZodType, Output = unknown> = {
  name: string
  description: string
  inputSchema: Input
  isReadOnly: boolean
  isConcurrencySafe: boolean
  call(input: z.infer<Input>, context: ToolContext): Promise<ToolResult<Output>>
  formatResult(output: Output): string
  activityDescription(input: Partial<z.infer<Input>>): string
}
```

**Tool registry** converts Zod schemas to JSON Schema for the OpenRouter API via `zod-to-json-schema`.

**Tools for v1:**

| Tool | ReadOnly | ConcurrencySafe | Implementation |
|------|----------|-----------------|----------------|
| Bash | no | no | `child_process.spawn`, streaming stdout/stderr |
| Read | yes | yes | `fs.readFile` with line numbers (`cat -n` style) |
| Write | no | no | `fs.writeFile`, validates dir exists |
| Edit | no | no | String replace with validation (must read first, unique match) |
| Glob | yes | yes | `globby` library |
| Grep | yes | yes | Spawns `rg` subprocess for speed |
| WebFetch | yes | yes | `fetch()` with timeout |

**Concurrent execution:** Read-only + concurrency-safe tools run in parallel via `Promise.all`. Non-safe tools run sequentially.

**Validation pattern (Edit example):**
- File must have been read in current session (tracked via `context.readFiles` Set)
- `old_string` must exist in file
- Must be unique unless `replace_all: true`
- `old_string !== new_string` (no-op rejection)

---

## 5. OpenRouter Provider

**Streaming:** POST to `/v1/chat/completions` with `stream: true`, parse SSE frames.

**SSE parser:** Buffers incomplete frames, splits on double-newline, parses `data:` field. Yields structured events: `text_delta`, `tool_use_start`, `tool_use_delta`, `message_complete`.

**Headers:** `Authorization`, `HTTP-Referer: https://darce.dev`, `X-Title: Darce`.

**Error handling:** Retry on 429 (rate limit) with exponential backoff. Surface 4xx/5xx as user-visible errors.

---

## 6. Smart Model Router

Maps conversation signals to the best model.

**RouterConfig in `.darcerc`:**

```json
{
  "router": {
    "default": "anthropic/claude-sonnet-4",
    "budget": "medium",
    "rules": [
      { "when": "large-context", "use": "google/gemini-2.5-pro" },
      { "when": "quick-question", "use": "deepseek/deepseek-v3" },
      { "when": "complex-reasoning", "use": "anthropic/claude-opus-4" }
    ]
  }
}
```

**Conditions:**
- `large-context`: estimated tokens > 100k
- `quick-question`: < 500 tokens, no tool results in history
- `complex-reasoning`: multiple tool rounds, > 10k tokens
- `image-input`: last message contains image content

**Hotkey override:** `Ctrl+M` opens ModelPicker — override router for current conversation. StatusBar always shows active model.

---

## 7. Configuration

**Layered loading (later overrides earlier):**
1. Built-in defaults
2. `~/.darcerc` (global)
3. `./.darcerc` (project-level)
4. Environment variables (`DARCE_API_KEY`, `DARCE_MODEL`)

**Config shape:**

```typescript
type DarceConfig = {
  apiKey: string
  router: RouterConfig
  theme: 'dark' | 'light' | 'auto'
  shell: string
  maxTurns: number
  historyPath: string
}
```

---

## 8. Cost Tracking

- Per-model accumulation: input tokens, output tokens, cost USD, request count
- Cost calculated from model pricing profiles + API response `usage` field
- Displayed in StatusBar in real-time: `$0.0342 | 45s`
- Persisted to `~/.darce/session-cost.json` on exit
- Restored on session resume (matched by session ID)
- Summary printed on exit (if cost > 0)

---

## 9. Conversation History

- JSONL append-only at `~/.darce/history.jsonl`
- Each entry: `{ input, timestamp, project, sessionId }`
- Up-arrow in Prompt reads history: current session first, then older
- Scoped to current project directory
- Max 100 entries returned

---

## 10. UI Components (Ink)

**Component tree:**

```
ThemeProvider
  AppStateProvider
    REPL
      Messages (scrollable, useDeferredValue for smooth updates)
        Message → AssistantTextMessage | ToolUseMessage | UserTextMessage
      StreamingText (line-by-line preview, separate from final messages)
      Spinner (animated, mode-aware)
      Prompt (input with readline history, multiline support)
      StatusBar (model | tokens | cost | cwd)
```

**Streaming text pattern:**
- Only complete lines shown (substring up to last `\n`)
- Cleared atomically when final message arrives
- Ink's 16ms render throttle batches rapid deltas

**Markdown rendering:**
- `marked` + `marked-terminal` for terminal-friendly markdown
- `cli-highlight` for syntax highlighting in code blocks
- Language detection from fenced code block tags

---

## 11. Performance Requirements

These are non-negotiable:

| Metric | Target |
|--------|--------|
| `darce --version` | < 10ms (fast-path, no Ink loaded) |
| Startup to first prompt | < 200ms |
| Time-to-first-token display | Network latency only (no processing overhead) |
| Tool dispatch overhead | < 1ms per tool |
| Streaming render | 60fps (Ink's 16ms throttle) |

**How we achieve this:**

1. **Lazy imports** — `cli.tsx` does arg parsing only. `main.tsx` and Ink loaded via dynamic `import()` only when needed.
2. **Single bundle** — `tsup` tree-shakes and bundles everything into one JS file. No `node_modules` resolution at runtime.
3. **No tiktoken** — token counting uses `chars / 4` approximation for UI. Exact counts come from API response `usage` field (free, already computed server-side).
4. **ripgrep for Grep** — spawns `rg` process, not a JS regex walker.
5. **Concurrent tools** — read-only tools run via `Promise.all`.
6. **Streaming tool execution** — tools begin executing the moment their JSON block is complete, not after the full response.
7. **Memoized context** — system prompt, git status computed once per session.
8. **`useDeferredValue`** — message list updates deferred to transition priority, keeping input responsive.

---

## 12. Distribution

```bash
npm install -g darce
```

**Binary entry point:** `bin/darce` → bundled `dist/cli.js`

**Usage:**
```bash
darce                          # Interactive REPL
darce "fix the login bug"      # Start with initial prompt
darce --model deepseek/deepseek-r1  # Override model
darce --version                # Fast-path version print
darce --help                   # Help text
```

---

## 13. Dependencies

```json
{
  "dependencies": {
    "ink": "^5.1.0",
    "react": "^18.3.0",
    "zod": "^3.23.0",
    "chalk": "^5.3.0",
    "marked": "^14.0.0",
    "marked-terminal": "^7.0.0",
    "cli-highlight": "^2.1.0",
    "globby": "^14.0.0",
    "zod-to-json-schema": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "tsx": "^4.16.0",
    "tsup": "^8.1.0"
  }
}
```

Zero native dependencies. Pure JS/TS. Installs in seconds.

---

## 14. Future Additions (Not in v1)

- Plugin/skill system (load custom tools from `.darce/tools/`)
- Multi-agent coordination (spawn sub-agents)
- Conversation persistence and resume
- MCP server integration
- Web UI mode (same core, different renderer)
- Voice input
