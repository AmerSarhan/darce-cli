<p align="center">
  <img src="https://img.shields.io/npm/v/darce-cli?style=flat-square&color=10b981" alt="npm">
  <img src="https://img.shields.io/npm/dw/darce-cli?style=flat-square&color=10b981" alt="downloads">
  <img src="https://img.shields.io/github/stars/AmerSarhan/darce-cli?style=flat-square&color=10b981" alt="stars">
  <img src="https://img.shields.io/github/license/AmerSarhan/darce-cli?style=flat-square" alt="license">
</p>

<h1 align="center">Darce</h1>

<p align="center">
  <strong>AI coding agent that lives in your terminal.</strong><br>
  Reads, writes, edits code, runs commands, searches codebases.<br>
  One command to install. One command to start.
</p>

<p align="center">
  <a href="https://cli.darce.dev">Website</a> &middot;
  <a href="https://www.npmjs.com/package/darce-cli">npm</a> &middot;
  <a href="#get-started">Get Started</a> &middot;
  <a href="https://cli.darce.dev/#pricing">Pricing</a> &middot;
  <a href="https://cli.darce.dev/dashboard">Dashboard</a>
</p>

---

```
> fix the authentication bug in login.ts

  I'll read the file first.

  ○ Read src/auth/login.ts
    1  import { verify } from './jwt'
    ... 45 more lines

  Found it — token expiry compares seconds vs milliseconds.

  ● Edit src/auth/login.ts
    File updated

  ● Bash npm test
    24/24 tests passing

  Fixed. Wrapped the Unix timestamp in * 1000.

qwen3-coder · 3.1k tokens · $0.0008 · 6s
```

## Why Darce?

- **Any model** — 300+ tool-capable models via OpenRouter: Claude, GPT, Gemini, Grok, DeepSeek, Kimi, GLM, Qwen. Switch mid-conversation.
- **Always current** — the model list is fetched live, so new models show up the day they launch.
- **Tiny** — 19 kB package, installs in seconds, starts instantly.
- **Free tier** — start without a credit card or an API key.
- **Open source** — MIT licensed.

## What's New in 0.5.0

- **Stop without quitting.** Esc or Ctrl+C stops the current task immediately (including the network request). Ctrl+C twice exits.
- **A real input editor.** Multi-line prompts (Shift+Enter, Ctrl+J, or `\` then Enter), word jumps (Alt+←/→), Ctrl+A/E/K/U/W/Y, bracketed paste that keeps newlines, and history across sessions.
- **Type while Darce works.** Messages you send mid-task are queued and run next.
- **Flicker-free output.** Finished output is printed once and never redrawn, so long sessions stay fast and scrollback stays clean.
- **Safer by default.** Commands Darce runs no longer see credential-like environment variables (allow specific ones with `passEnv` in `~/.darcerc`), and known secret formats are redacted before anything is sent to a model.
- **`darce --resume` works** — the conversation and its history come back.
- **`darce -p "task"`** prints the result and exits, for scripts and CI.
- Fixed: Edit corrupting replacements that contain `$&` or `$1`; tool errors now show the real reason.

## Get Started

```bash
npm install -g darce-cli
darce
```

That's it. The first run creates your free account right in the terminal (email + password, no card) and drops you straight into a session. No config files. No API keys to copy. No Docker.

Requires Node.js 22 or newer. Already installed? Update with `npm install -g darce-cli@latest`.

## What Can It Do?

**Fix bugs** — Describe the issue, Darce reads the code, finds the problem, fixes it, runs your tests.

**Build features** — "Add a dark mode toggle to the settings page" — Darce creates the files, writes the code, wires everything up.

**Refactor** — "Convert this class component to a hook" — reads the file, rewrites it, verifies nothing broke.

**Explore codebases** — "How does authentication work in this project?" — searches files, reads code, explains the architecture.

**Run commands** — "Install tailwind and set it up" — runs npm, creates config files, updates your code.

## Features

```
/help     List commands          Esc / Ctrl+C   Stop Darce (Ctrl+C twice exits)
/model    Pick / search models   Shift+Enter    New line (also Ctrl+J, or \ then Enter)
/clear    Reset conversation     Up/Down        Input history
/cost     Session costs          Ctrl+P         Model picker
/compact  Shrink context         Ctrl+L         Clear the screen
```

- **7 tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch
- **Smart routing** — auto-picks the best model for each task
- **Streaming** — responses appear line-by-line as they generate
- **Git-aware** — knows your branch, changes, and recent commits
- **Session resume** — `darce --resume` picks up where you left off
- **Context compaction** — stays fast even in long conversations
- **Cost tracking** — real-time token count and spend in the status bar
- **Account dashboard** — usage stats at [cli.darce.dev/dashboard](https://cli.darce.dev/dashboard)

## Models

Every tool-capable model on [OpenRouter](https://openrouter.ai/models) — 300+ and counting. The list is fetched live (cached for 24h), so new models show up the day they launch.

Open the picker with `/model` and type to search, or jump straight to one:

```
/model sonnet-5.5        # switch by name
/model kimi              # search — switches if there's one match
/model someone/new-model # any OpenRouter model ID
darce --model openai/gpt-5.6-sol
```

The picker shows context window, price per million tokens, and vision/reasoning support for each model. Default: `qwen/qwen3-coder`.

## Pricing

Start free. Upgrade when you need more. Cancel anytime.

| | Starter | Builder | Power |
|---|---|---|---|
| **Price** | Free | $15/mo | $65/mo |
| **Requests** | 25/mo | 500/mo | 2,500/mo |
| **Models** | qwen3-coder | All | All + priority |
| **Tools** | 3 (Read, Grep, Glob) | All 7 | All 7 |
| **Sessions** | No resume | Resume + history | Resume + history |
| **Dashboard** | Basic | Full | Full + priority support |

```bash
darce                 # Start free — sets up your account on first run
darce upgrade         # Upgrade to Builder or Power
```

Or sign up at [cli.darce.dev](https://cli.darce.dev)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/model` | Open the model picker (`/m` alias) |
| `/model <search>` | Switch model by name or ID |
| `/clear` | Clear conversation (`/c` alias) |
| `/cost` | Show session cost breakdown |
| `/compact` | Compact conversation history |
| `/quit` | Exit (`/q` alias) |

## Config

`darce login` handles everything. For power users:

```json
// ~/.darcerc
{
  "apiKey": "darce-...",
  "apiBase": "https://api.darce.dev",
  "router": {
    "default": "qwen/qwen3-coder",
    "rules": [
      { "when": "large-context", "use": "google/gemini-3.1-pro-preview" },
      { "when": "complex-reasoning", "use": "anthropic/claude-sonnet-5.5" }
    ]
  }
}
```

## Safety

Commands Darce runs get your environment **minus** variables that look like credentials (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `DATABASE_URL`, …). If a command needs one, allow it explicitly:

```json
// ~/.darcerc
{ "passEnv": ["GH_TOKEN", "NPM_TOKEN"] }
```

Tool output is scanned for well-known secret formats (API keys, tokens, private keys) and redacted before it reaches a model.

## Contributing

```bash
git clone https://github.com/AmerSarhan/darce-cli.git
cd darce-cli
npm install
npm run dev           # Run from source
npm test              # 139 tests
npm run build         # Build for production
```

## Star History

If Darce saved you time, drop a star. It helps others find it.

[![Star History Chart](https://api.star-history.com/svg?repos=AmerSarhan/darce-cli&type=Date)](https://star-history.com/#AmerSarhan/darce-cli&Date)

---

<p align="center">
  Built by <a href="https://darce.dev">darce.dev</a><br>
  <sub><a href="LICENSE">MIT License</a></sub>
</p>
