<h1 align="center">Darce</h1>

<p align="center">
  <strong>The coding agent you can undo.</strong><br>
  Darce works in your terminal with 250+ models. Every change it makes, even what its shell commands did,<br>
  rolls back with <code>/undo</code>. Anything risky asks first.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/darce-cli"><img src="https://img.shields.io/npm/v/darce-cli?style=flat-square&color=e8892b" alt="npm"></a>
  <a href="https://www.npmjs.com/package/darce-cli"><img src="https://img.shields.io/npm/dm/darce-cli?style=flat-square&color=e8892b" alt="downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AmerSarhan/darce-cli?style=flat-square" alt="MIT license"></a>
  <a href="https://discord.gg/u447rt6Xfq"><img src="https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/demo-undo.gif" width="880" alt="Darce runs rm -rf after flagging it as destructive and asking first, then /undo restores all four deleted files and the tests pass again">
</p>

```bash
npm install -g darce-cli
darce
```

The first run lets you try it straight away with 10 free requests, no account needed. When you want more, `darce signup` creates a free account (25 requests a month, no card) and keeps your history. Needs Node.js 22+.

## What makes it different

- **Undo anything.** Every step is a checkpoint, including files a shell command created, changed or deleted, not just the agent's own edits. `/undo` steps back one change; `/rewind` (or Esc twice) scrubs through the whole session. In a git repo it uses private refs and never touches your branch, index or stash.
- **It asks before anything risky.** Every command is scored before it runs. Reading runs straight away; deleting, force-pushing, installing or piping the internet into a shell waits for you, with the reason shown.
- **Swarms.** `/swarm <task>` has a lead agent split the work into 2-4 independent parts. Each runs as its own agent in a separate git worktree, at the same time, and the results merge back in one step (`/undo` reverts the lot).
- **Model derby.** `/derby <task>` races three models on the same task in separate worktrees. Compare their diffs, test results and cost, then keep the one you'd merge.
- **250+ coding models.** Claude, GPT, Gemini, Qwen, DeepSeek, Kimi, GLM, Grok and more, live from OpenRouter, filtered to models that can actually drive an agent. Switch mid-task with Shift+↑/↓.
- **It tells you why.** When a fix hinges on something you can't see in the code (a language quirk, a React rule, async ordering, SQL injection), Darce ends with a short WHY note so you spot it next time. Routine edits get none.

<p align="center">
  <img src="assets/demo-swarm.gif" width="880" alt="/swarm splits a task into three threads that run in parallel in their own worktrees, then merges them; 17 tests pass">
</p>

## What else it does

- **Threads.** The agent can hand research to sub-agents with their own context; several run in parallel. `/threads` shows what each one did.
- **Images.** Generates icons, illustrations and hero images into your project, with transparent backgrounds when you ask (GPT Image by default; Gemini and Seedream on request).
- **Resume.** `/resume` picks up any past conversation, in this folder or any other.
- **Skills and memory.** Drop a `SKILL.md` into `.darce/skills/` to teach it your team's way of doing things; it remembers your preferences across sessions.
- **Screenshots.** Paste one with Ctrl+V and Darce can see it.
- **Second opinion.** `/critic on` has a model from another vendor review every edit.
- **Scripts and CI.** `darce -p "task"` prints the result and exits.

## Commands

| Command | What it does |
|---------|-------------|
| `/undo` | Undo the last change, including what shell commands did (`/u`) |
| `/rewind` | Scrub through every change and rewind files and conversation (also Esc twice) |
| `/diff` | Every file Darce changed this session |
| `/swarm <task>` | Split a task into parallel agents, each in its own worktree, then merge |
| `/derby [--models a,b,c] <task>` | Race models on a task and apply the best result |
| `/threads [n]` | This session's threads, or one thread's steps and report |
| `/model [search]` | Pick or search models (Ctrl+P) |
| `/mode auto\|ask\|plan\|full` | Approval mode (Shift+Tab cycles) |
| `/resume` | Continue a past conversation |
| `/why on\|off` | WHY notes (on by default) |
| `/critic on\|off [model]` | Second-opinion review of every edit |
| `/security [changes]` | Security review of the project or your uncommitted changes |
| `/memory [forget <text>]` | What Darce remembers about you and this project |
| `/skills` | Available skills |
| `/suggest on\|off` | Predict your next prompt (Tab accepts) |
| `/compact`, `/clear`, `/cost` | Shrink context, start over, session costs |
| `/debug` | Timing of requests, tools and waits in this session |
| `/login`, `/account`, `/logout` | Sign in, plan and usage, switch accounts |
| `/community` | Join the Discord |

Keys: Esc stops Darce without quitting, Shift+Enter adds a line, Up/Down walks history, Ctrl+R searches it, Ctrl+O shows a step's full output.

## Safety

| Mode | Read-only steps | Edits and builds in the project | Network, installs, unknown commands | Destructive (`rm -rf`, `sudo`, force-push…) |
|---|---|---|---|---|
| `auto` (default) | run | run | ask | ask |
| `ask` | run | ask | ask | ask |
| `plan` | run | blocked | blocked | blocked |
| `full` | run | run | run | run |

- Commands Darce runs don't see environment variables that look like credentials (`*_KEY`, `*_TOKEN`, `*_SECRET`, `DATABASE_URL`…). Allow one with `"passEnv": ["GH_TOKEN"]` in `~/.darcerc`.
- Known secret formats are redacted from tool output before anything reaches a model.
- Scripts the rules would run unasked (`npm run x`, `node scripts/x.js`, `make y`) get a second look first: Darce reads the real `package.json` script, and asks a fast classifier ([TypeSafe Jev](https://typesafe.ai), via api.darce.dev) whether running it changes anything outside your machine, given the command, the script line and the start of the file it runs. It can only make Darce more careful. Turn it off with `"riskCheck": false`.
- A repository's own `.darcerc`, instruction files and skills can't change your approval mode, endpoints or keys, and your own skills take precedence over a repository's.
- Your key, history and sessions are stored readable only by you.

## Models

The picker (`/model`) opens with your recent models, then OpenRouter's live most-popular ranking. It lists models that can drive a coding agent: tool calling, a 64k+ context, current generation. Any other model still works by name:

```
/model sonnet-5.5        # switch by name
/model kimi              # search; switches if there's one match
darce --model openai/gpt-5.6-sol
```

## Pricing

| | Starter | Builder | Power |
|---|---|---|---|
| **Price** | Free | $15/month | $65/month |
| **Requests** | 25/month | 500/month | 2,500/month |
| **Models** | Fast open models (Qwen, DeepSeek, Gemini Flash…) | Most models, including Claude Sonnet | Every model, including Opus |

Every plan gets every feature. Upgrade with `/upgrade` or at [cli.darce.dev](https://cli.darce.dev); cancel any time.

## Config

Everything is optional; `darce` sets up `~/.darcerc` on first run.

```json
{
  "mode": "auto",
  "router": { "default": "qwen/qwen3-coder" },
  "gears": ["qwen/qwen3-coder-next", "qwen/qwen3-coder", "deepseek/deepseek-v4-pro", "anthropic/claude-sonnet-5.5"],
  "derbyModels": ["anthropic/claude-sonnet-5.5", "openai/gpt-5.6-sol", "google/gemini-3.1-pro-preview"],
  "critic": false,
  "why": true,
  "passEnv": ["GH_TOKEN"]
}
```

## Skills

A skill is a folder with a `SKILL.md`:

```markdown
---
name: deploy
description: How this team deploys the API. Use when asked to ship or release.
---
1. Run `make test`.
2. ...
```

Darce looks in `~/.darce/skills/` and `~/.claude/skills/` first, then the project's `.darce/skills/` and `.claude/skills/`, and installed Claude Code plugins.

## Community

Darce is built in public by one developer. Questions, ideas, bugs, or something you built with it: join the **[Discord](https://discord.gg/u447rt6Xfq)** or type `/community` inside Darce. See [CHANGELOG.md](CHANGELOG.md) for what's new.

## Contributing

```bash
git clone https://github.com/AmerSarhan/darce-cli.git
cd darce-cli
npm install
npm run dev     # run from source
npm test        # the test suite
npm run build
```

Issues and pull requests are welcome. Good first issues are labelled [`good first issue`](https://github.com/AmerSarhan/darce-cli/labels/good%20first%20issue).

[![Star History Chart](https://api.star-history.com/svg?repos=AmerSarhan/darce-cli&type=Date)](https://star-history.com/#AmerSarhan/darce-cli&Date)

<p align="center"><sub><a href="LICENSE">MIT License</a> · <a href="https://cli.darce.dev">cli.darce.dev</a></sub></p>
