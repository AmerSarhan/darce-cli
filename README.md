# Darce

A blazing-fast AI coding agent for your terminal. Built by [darce.dev](https://darce.dev).

```
╭ Darce v0.1.0 (qwen3-coder)

> fix the authentication bug in login.ts

  I'll start by reading the file to understand the current implementation.

  Read src/auth/login.ts

  Found the issue — the token expiry check is comparing timestamps
  in different formats. Here's the fix:

  Edit src/auth/login.ts
  ✓ File updated

  Let me verify the fix works:

  Bash npm test
  ✓ All 24 tests passing

  Fixed. The bug was comparing a Unix timestamp (seconds) against
  Date.now() (milliseconds). Wrapped it in `* 1000`.

> _
qwen3-coder · 4.2k tokens · $0.0012 | 8s · ~/projects/myapp
```

## Install

```bash
npm install -g darce-cli
```

Or run directly:

```bash
npx darce-cli
```

## Setup

Darce uses [OpenRouter](https://openrouter.ai) to access any AI model. Get an API key and set it:

```bash
# Environment variable
export DARCE_API_KEY=sk-or-...

# Or config file
echo '{"apiKey":"sk-or-..."}' > ~/.darcerc
```

That's it. Start coding:

```bash
darce                              # Interactive REPL
darce "explain this codebase"      # Start with a prompt
darce --model x-ai/grok-4.1-fast  # Use a specific model
```

## Features

**7 built-in tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch. The agent reads your code, makes changes, runs commands, and searches your codebase.

**Smart model routing** — Automatically picks the best model based on your task. Quick question? Uses a fast model. Complex multi-file refactor? Switches to a reasoning model. Override anytime with `Ctrl+M`.

**Streaming everything** — Responses stream token-by-token. Tool results appear as they complete. No waiting for full responses.

**Blazing fast** — Sub-200ms startup. 190ms builds. Lazy imports mean `darce --version` exits in under 10ms.

**Cost tracking** — See per-model token usage and cost in real-time. Session costs persist across restarts.

## Models

Darce defaults to `qwen/qwen3-coder`. Configure any OpenRouter model in `.darcerc`:

```json
{
  "apiKey": "sk-or-...",
  "router": {
    "default": "qwen/qwen3-coder",
    "rules": [
      { "when": "large-context", "use": "google/gemini-2.5-pro" },
      { "when": "quick-question", "use": "deepseek/deepseek-chat" },
      { "when": "complex-reasoning", "use": "x-ai/grok-4.1-fast" }
    ]
  }
}
```

Switch models mid-conversation with **Ctrl+M**.

## Hotkeys

| Key | Action |
|-----|--------|
| `Ctrl+M` | Switch model |
| `Ctrl+C` | Cancel current request / Exit |
| `Up/Down` | Navigate input history |

## Config

Darce loads config from three layers (later overrides earlier):

1. `~/.darcerc` — Global defaults
2. `./.darcerc` — Project-specific
3. Environment variables — `DARCE_API_KEY`, `DARCE_MODEL`

## Architecture

```
src/
├── entrypoints/cli.tsx    — CLI entry, arg parsing, lazy boot
├── core/query.ts          — Async generator conversation loop
├── core/streaming.ts      — SSE frame parser
├── providers/openrouter.ts — OpenRouter API + streaming
├── providers/router.ts    — Smart model selection
├── tools/                 — 7 tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch)
├── ui/                    — Ink (React) terminal components
├── config/                — Layered .darcerc loading
└── state/costTracker.ts   — Per-model cost tracking
```

Built with TypeScript, [Ink](https://github.com/vadimdemedes/ink), Zod, and [tsup](https://github.com/egoist/tsup).

Inspired by [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## License

MIT
