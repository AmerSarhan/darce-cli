# Changelog

Release notes for [darce-cli](https://www.npmjs.com/package/darce-cli). Newest first.

## 0.13.1

- **Brain view polish.** Search steps show project paths instead of full system paths, and Darce's short "Now I'll…" narration between steps is shown as a quiet aside so the steps stay easy to follow.

## 0.13.0

- **Brain view.** `/brain` opens a live map of your project in the browser: every file a dot, grouped by folder, wired by its imports. Watch Darce's attention move across it: reads glow, edits pulse orange and send a signal to every file that depends on the change. The feed shows each step as it happens, and the timeline replays the session step by step with diffs. Runs on your computer only.
- **Early-beta codes.** `darce redeem <CODE>` (or `/redeem`) turns on Power for 60 days.

## 0.12.11

- **Derby you can steer.** While models race, press 1-3 or ↑↓ to read any finished one, and Enter to take it right away (the rest stop). Questions work too: if the winner changed no files, its answer becomes Darce's reply, shown in full on the board. The prompt line no longer claims you can type while the board has the keys.
- **Fewer filler WHY notes.** Opinions, reviews and overviews no longer get a WHY, and notes that only describe the answer itself are dropped.

## 0.12.10

- **No freeze in big folders.** Starting Darce in a folder that holds many projects (each with its own node_modules) could pin the CPU and freeze the screen while it listed files for @mentions. File listing now uses git where it can, skips dependency folders at any depth, and stops early; a 100-project folder lists in under 0.2s. Broad Glob searches outside a repository stop early too.

## 0.12.9

- **Darce can talk.** `/voice on` and Darce gives you short spoken updates during long tasks, when it needs your approval, and when it's done, in a natural ElevenLabs v4 voice. Pick a voice with `/voice erik|joe|zara|callum|charlotte`, set your name with `/voice name <first name>`. Audio plays in the background, so tasks never wait on it. Paid plans get plenty of lines each month; free plans get a taste.
- **No more silent waits.** When a model's provider is slow to start, Darce now says so ("Waiting for qwen3-coder · trying a faster provider") while the server races a second, faster provider and keeps whichever answers first. Provider errors that arrive mid-stream are shown instead of ending the turn silently, and a truly stuck request gives up after 45s instead of 90s.
- **Faster launch.** Compiled code is cached on disk, so Darce starts quicker after the first run.

## 0.12.8

- **Better images.** Images now come from OpenAI's GPT Image 2.5 by default on every plan: sharper, great with text, and it can make transparent backgrounds for icons and logos. A default image counts as 2 requests. Google's Nano Banana 2 and Pro (paid plans) and Seedream are available too.
- **Transparent images without holes.** Icons and logos with solid fills keep their fills when the background is removed.
- **WHY notes you'll actually see.** When a fix hinges on something the code doesn't show (floating point, React effect rules, async ordering, SQL injection), Darce now reliably ends with a short WHY note, and skips it for routine edits. Toggle with `/why on|off`.

## 0.12.7

- **Prompt caching.** Each conversation stays on one model provider and marks its repeated prefix (instructions and tool list) for caching, so follow-up calls reuse it: cheaper and faster replies, especially with Claude, Gemini and Qwen.

## 0.12.6

- Fixed: after sharing an image, the next message failed with "No endpoints found that support image input" when the main model can't see images.

## 0.12.5

- **Try it without an account.** The first run offers 10 free requests with no sign-up; `darce signup` turns the trial into a free account and keeps your history.
- **Effects /undo can't reverse ask first.** Deploy, migrate, seed and release scripts, database clients, and scripts that look like they change things outside your machine (a second opinion from TypeSafe Jev) now wait for you, and the prompt says /undo can't reverse them. Destructive SQL is flagged as dangerous.

## 0.12.1 – 0.12.4

- `/resume`: pick any past conversation (this folder or all) and continue it.
- The model picker lists only models that can drive a coding agent (250+).
- Faster, bounded file search in big folders; Grep works without ripgrep installed.
- A timing trace (`/debug`) and a hint when a model is slow to reply.
- Fewer needless approval prompts (`cd` and `git -C` inside your project).
- The end-of-task receipt counts files changed by shell commands.

## 0.12.0

- **Threads.** Darce can start sub-agents with their own fresh context. Several research threads run at the same time, and a work thread can take on a self-contained change. You see each thread live, and `/threads` shows every thread's steps and report.
- **Swarms.** `/swarm add search, pagination and an export button` has a lead agent split the task into 2-4 independent parts. Each part runs as a thread in its own git worktree, in parallel. Review them side by side, then merge everything with Enter: edits to the same file are combined, and `/undo` reverts the whole swarm.
- **Images.** Darce can generate images into your project (icons, illustrations, hero images, or edits of an existing image) with Seedream 5.0 Flash. Each image counts as 3 requests.
- **WHY notes.** When a change involved something genuinely worth knowing, Darce ends with a short WHY note. Routine changes get none. `/why off` turns it off.
- **Safer by default.** A security audit tightened command approvals, how a repository's own settings and instructions are trusted, and the permissions of your key and session files.
- A model that stops responding is retried once and then reported, instead of leaving Darce waiting.

## 0.11.0

- **Easier model picking.** `/model` (or Ctrl+P) now opens with your recent models, then OpenRouter's live **most popular** ranking, then everything else. Each row shows a friendly name, vendor, price level ($ to $$$$), context size and what it can do. Search matches every word you type and ranks results by popularity.
- `/model` and other commands with optional arguments run straight from the slash menu on Enter.

## 0.10.0

- **Images and screenshots.** Press Ctrl+V to paste a screenshot from your clipboard, or drag image files into the terminal. They show up as `[Image #1]` and go to the model with your message. If your current model can't see images, Darce hands that message to a fast vision model automatically (`visionModel` in `~/.darcerc` to choose).
- **Darce predicts your next step.** After each task, a small fast model suggests what you'll likely ask next as ghost text in the prompt. Tab or → accepts it. On by default for paid plans; `/suggest on|off` to change.
- **Cleaner answers.** A new terminal markdown renderer: bold, code and links render properly everywhere (including inside lists and tables), long bullets wrap with a hanging indent, code blocks are highlighted, links are clickable.

## 0.9.0

- **A proper welcome.** The DARCE wordmark sweeps in with an ember gradient, then a welcome card shows your model, approval mode, project, account, plan and requests left, plus the shortcuts worth knowing.

## 0.8.0

- **A much smarter brain.** Darce now works like a senior engineer: understand → plan → change → verify, with a live **plan checklist** you can watch. It reads your project's `AGENTS.md` / `CLAUDE.md` / `.cursorrules`, gets a quick overview of your stack and scripts, and follows built-in engineering standards (proof over assurances, no surprise deploys, no AI attribution in commits).
- **Skills — any skill.** Drop a `SKILL.md` into `~/.darce/skills/<name>/` or `.darce/skills/` and Darce loads it when a task matches. Your existing Claude Code skills (`~/.claude/skills`, plugin skills) work as-is. Built in: `ui-craft` (how to build interfaces that don't look generated), `security-review`, `teach`, `web-research`. See them with `/skills`.
- **Memory.** Darce remembers your preferences and project facts across sessions when you correct it or tell it something. `/memory` shows what it knows; edit or `/memory forget` anything.
- **Web search and stealth browsing.** `WebSearch` finds current docs and answers; `WebFetch` now returns clean markdown and retries blocked pages in a stealth browser (with a Scrapify endpoint configured).
- **Security advisor.** `/security` reviews the whole project (or `/security changes` for just your diff) and reports exploitable issues by severity, with proof and fixes.
- **Learn mode.** `/learn on` and Darce explains the concepts behind each change and checks your understanding.
- **Slash menu and @files.** Type `/` to see every command; type `@` to fuzzy-find a file and attach it to your message. Ctrl+R searches your prompt history.
- **Accounts.** `/login` signs in through your browser; `/account` shows your plan and usage and switches between saved accounts; `/logout` signs out.

## 0.7.0

Things no other terminal agent does:

- **Model Derby** — `/derby fix the flaky login test` races up to three models from different vendors on the same task, each in its own git worktree. Watch them work side by side, compare their diffs and costs, and apply the winner with Enter. Your files are untouched until you choose.
- **Rewind tape** — press Esc twice (or `/rewind`) to scrub through every change Darce made, with a live diff of each step. Enter puts your files *and* the conversation back to before that step.
- **Gear shift** — Shift+↑ / Shift+↓ moves to a smarter or cheaper model instantly, even mid-task, with the price difference shown before the next step runs.
- **Second opinion** — `/critic on` has a model from a *different* vendor review every edit within seconds and flag bugs inline. Different vendor, different blind spots.
- **Receipts** — every task ends with a summary card: files changed, commands run, who approved what, the highest risk taken, models used, tokens, cost and time.

```
╭──────────────────────────────────────────────────────────────╮
│ files   1 changed +1 −1  auth.ts                             │
│ shell   1 command                                            │
│ risk    █░░ changed the project                              │
│ model   qwen3-coder → deepseek-v4-pro  2.6k tokens · $0.0018 │
│ time    41s   /undo · /diff · /rewind                        │
╰──────────────────────────────────────────────────────────────╯
```

## 0.6.0

- **Approvals ranked by risk.** Every command is parsed and scored: read-only, changes the project, reaches outside, or destructive. In the default `auto` mode safe steps just run; risky ones show what will happen and why, and you answer with one key (`y` once, `a` always for this command in this project, `n` deny). Destructive commands can never be "always allowed".
- **Four modes, Shift+Tab to switch.** `auto` (default), `ask` (approve every change), `plan` (read-only: Darce proposes, doesn't touch), `full` (nothing asks). Also `--mode` and `/mode`.
- **`/undo` that covers shell commands too.** Before every change, Darce snapshots your working tree (without touching your branch, index or stash), so `/undo` reverses edits *and* whatever a command did — created, deleted or modified files.
- **Diffs for every edit**, syntax-highlighted with line numbers, plus `/diff` for everything Darce changed this session. Ctrl+O shows the full output of the last step.
- **Web content guard.** After Darce reads a web page, commands that would normally run automatically ask first, so a malicious page can't quietly steer it.
- **Terminal integration.** Clickable file paths, a progress indicator in the tab, a desktop notification when a long task finishes or needs you, and a live window title.

## 0.5.0

- **Stop without quitting.** Esc or Ctrl+C stops the current task immediately (including the network request). Ctrl+C twice exits.
- **A real input editor.** Multi-line prompts (Shift+Enter, Ctrl+J, or `\` then Enter), word jumps (Alt+←/→), Ctrl+A/E/K/U/W/Y, bracketed paste that keeps newlines, and history across sessions.
- **Type while Darce works.** Messages you send mid-task are queued and run next.
- **Flicker-free output.** Finished output is printed once and never redrawn, so long sessions stay fast and scrollback stays clean.
- **Safer by default.** Commands Darce runs no longer see credential-like environment variables (allow specific ones with `passEnv` in `~/.darcerc`), and known secret formats are redacted before anything is sent to a model.
- **`darce --resume` works** — the conversation and its history come back.
- **`darce -p "task"`** prints the result and exits, for scripts and CI.
- Fixed: Edit corrupting replacements that contain `$&` or `$1`; tool errors now show the real reason.
