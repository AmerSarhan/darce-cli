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

| | Darce | Claude Code | Cursor | GitHub Copilot CLI |
|---|:---:|:---:|:---:|:---:|
| **Works in any terminal** | Yes | Yes | No (IDE only) | Partial |
| **Any model** (Claude, Grok, Gemini, DeepSeek, Llama) | Yes | Claude only | Limited | GPT only |
| **Reads + edits files** | Yes | Yes | Yes | No |
| **Runs shell commands** | Yes | Yes | No | Yes |
| **Smart model switching** | Yes | No | No | No |
| **Free tier** | Yes | No | No | No |
| **Open source** | Yes | Partial | No | No |
| **Install time** | 3 seconds | Minutes | Minutes | Minutes |
| **Package size** | 14 kB | ~200 MB | ~500 MB | ~100 MB |

## Get Started

```bash
npm install -g darce-cli
darce login
darce
```

That's it. No config files. No API keys to copy. No Docker.

## What Can It Do?

**Fix bugs** — Describe the issue, Darce reads the code, finds the problem, fixes it, runs your tests.

**Build features** — "Add a dark mode toggle to the settings page" — Darce creates the files, writes the code, wires everything up.

**Refactor** — "Convert this class component to a hook" — reads the file, rewrites it, verifies nothing broke.

**Explore codebases** — "How does authentication work in this project?" — searches files, reads code, explains the architecture.

**Run commands** — "Install tailwind and set it up" — runs npm, creates config files, updates your code.

## Features

```
/help     List commands          Ctrl+M   Switch models
/model    Change model           Ctrl+C   Cancel / Exit
/clear    Reset conversation     Up/Down  Input history
/cost     Session costs          """      Multi-line mode
/compact  Shrink context
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

Switch mid-conversation with `Ctrl+M` or `/model`.

| Model | Best for | Speed |
|-------|----------|-------|
| `qwen/qwen3-coder` | General coding (default) | Fast |
| `x-ai/grok-4.1-fast` | Complex reasoning | Fast |
| `anthropic/claude-sonnet-4` | Precise coding | Medium |
| `google/gemini-2.5-pro` | Huge codebases (1M ctx) | Medium |
| `deepseek/deepseek-r1` | Deep reasoning | Slower |
| `deepseek/deepseek-chat` | Quick questions | Very fast |
| `meta-llama/llama-4-maverick` | Open source (1M ctx) | Fast |

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
darce login           # Start free
darce upgrade         # Upgrade to Builder or Power
```

Or sign up at [cli.darce.dev](https://cli.darce.dev)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/model <id>` | Switch model (`/m` alias) |
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
      { "when": "large-context", "use": "google/gemini-2.5-pro" },
      { "when": "complex-reasoning", "use": "x-ai/grok-4.1-fast" }
    ]
  }
}
```

## Contributing

```bash
git clone https://github.com/AmerSarhan/darce-cli.git
cd darce-cli
npm install
npm run dev           # Run from source
npx tsx test.ts       # 106 tests
npm run build         # Build for production
```

## Star History

If Darce saved you time, drop a star. It helps others find it.

[![Star History Chart](https://api.star-history.com/svg?repos=AmerSarhan/darce-cli&type=Date)](https://star-history.com/#AmerSarhan/darce-cli&Date)

---

<p align="center">
  Built by <a href="https://darce.dev">darce.dev</a><br>
  <sub>MIT License</sub>
</p>
