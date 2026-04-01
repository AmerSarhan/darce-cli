# Darce CLI

A blazing-fast AI coding agent for your terminal. By [darce.dev](https://darce.dev).

[![npm version](https://img.shields.io/npm/v/darce-cli)](https://www.npmjs.com/package/darce-cli)
[![npm downloads](https://img.shields.io/npm/dw/darce-cli)](https://www.npmjs.com/package/darce-cli)

```
> Darce v0.3.0 (qwen3-coder)

> fix the auth bug in login.ts

  I'll read the file first.

  ○ Read src/auth/login.ts
    1  import { verify } from './jwt'
    ... 45 more lines

  Found it — token expiry compares seconds vs milliseconds.

  ● Edit src/auth/login.ts
    File updated

  ● Bash npm test
    24/24 tests passing

  Fixed. Wrapped the Unix timestamp in `* 1000`.

> _
qwen3-coder · 3.1k tokens · $0.0008 | 6s · ~2% ctx · ~/project
```

## Install

```bash
npm install -g darce-cli
```

## Get Started

```bash
darce login          # Create account or sign in
darce                # Start the REPL
darce "fix the bug"  # Start with a prompt
darce --resume       # Continue previous session
```

That's it. No config files, no env vars.

## Features

**7 built-in tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch. The agent reads your code, makes changes, runs commands, and searches your codebase.

**Smart model routing** — Automatically picks the best model for the task. Quick question? Fast model. Complex multi-file refactor? Reasoning model. Override with `Ctrl+M` or `/model`.

**Streaming responses** — Text streams line-by-line. Tool calls show live as they execute. No waiting.

**Slash commands** — `/help`, `/model`, `/clear`, `/cost`, `/compact`, `/quit`. Instant local commands without hitting the API.

**Multi-line input** — Type `"""` or ` ``` ` to enter multi-line mode. Paste code blocks freely.

**Session persistence** — Conversations auto-save. Resume with `darce --resume`.

**Context compaction** — When conversations get long, Darce automatically compacts old messages to stay fast.

**Git-aware** — Knows your branch, status, recent commits, and uncommitted changes.

**Cost tracking** — Per-model token usage and cost in real-time. Context window usage shown as `% ctx`.

**Blazing fast** — Sub-200ms startup. 14 kB on npm. Lazy imports. Tree-shaken.

## Models

Switch models mid-conversation with `Ctrl+M` or `/model <id>`.

| Model | Strengths |
|-------|-----------|
| `qwen/qwen3-coder` | Fast, great at coding (default) |
| `x-ai/grok-4.1-fast` | Fast, strong reasoning |
| `anthropic/claude-sonnet-4` | Excellent coding + reasoning |
| `google/gemini-2.5-pro` | 1M context window |
| `deepseek/deepseek-r1` | Deep reasoning |
| `deepseek/deepseek-chat` | Fast, cheap |
| `meta-llama/llama-4-maverick` | Open source, 1M context |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/model <id>` | Switch model (`/m` alias) |
| `/clear` | Clear conversation (`/c` alias) |
| `/cost` | Show session cost breakdown |
| `/compact` | Compact conversation history |
| `/quit` | Exit (`/q` alias) |

## Hotkeys

| Key | Action |
|-----|--------|
| `Ctrl+M` | Model picker |
| `Ctrl+C` | Cancel request / Exit |
| `Up/Down` | Input history |

## Pricing

| | Free | Pro ($20/mo) |
|---|------|-------------|
| Requests | 50/day | 5,000/day |
| Models | 3 basic | All models |
| Tools | 5 tools | All 7 tools |
| Routing | Basic | Smart routing |

Sign up at [cli.darce.dev](https://cli.darce.dev) or run `darce login`.

## Config

Darce stores credentials in `~/.darcerc` (created by `darce login`). You can also use:

- `./.darcerc` — Project-specific overrides
- `DARCE_API_KEY` / `DARCE_API_BASE` — Environment variables

```json
{
  "apiKey": "darce-...",
  "apiBase": "https://api.darce.dev",
  "router": {
    "default": "qwen/qwen3-coder",
    "rules": [
      { "when": "large-context", "use": "google/gemini-2.5-pro" },
      { "when": "complex-reasoning", "use": "x-ai/grok-4.1-fast" }
    ]
  }
}
```

## License

MIT
