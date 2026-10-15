# Changelog

Release notes for [darce-cli](https://www.npmjs.com/package/darce-cli). Newest first.

## 0.17.0

- **Windows: shell commands work.** Without Git Bash, every command used to fail, because Darce ran `cmd.exe -c`, a flag cmd doesn't have. Darce now picks Git Bash, then PowerShell, then cmd, with each one's own syntax, and tells the model which shell it's in. Timeouts and Esc stop the whole process tree. (Tested with simulated Windows setups; please report anything odd.)
- **Search finds what you ask for.**
  - A file filter like `*.js` no longer brings back matches from `node_modules`, `dist` and other skipped folders.
  - Filters with a folder (`src/*.ts`) match.
  - One unreadable file no longer hides every other match.
  - `(?i)` works for case-insensitive search, including without ripgrep.
  - Globs that start inside a skipped folder (`node_modules/pkg/*.js`) list its files.
- **Big pastes stay fast.** A paste over 12 lines shows as `[Pasted text #1: 3,012 lines]` in the prompt and is sent in full. Typing after a 3,000-line paste went from 140 ms to under 1 ms a key. Backspace removes the whole paste, and Up brings back the full text.
- **The prompt never takes over the screen.** A long message shows the lines around your cursor, so the terminal stops redrawing everything on every key.
- **Faster start.** Syntax highlighting, `/taste`, `/brain` and voice load the first time you use them. The main bundle is a third smaller.
- **Derby races the newest models:** Claude Sonnet 5.5, GPT-6.1 Sol (half the price of 5.6) and Gemini 4 Argon.
- **Derby and swarm clean up after themselves.** Closing Darce mid-race removes the racers' worktrees, a race that's stopped finishes its current step before its folder goes, and worktrees left by a crash are cleared before the next race.
- **Clearer errors when the service is low on model credit.** Big models now fall back to a smaller output budget instead of failing, and the message says what's going on instead of linking to a billing page you can't use.

## 0.16.0

Stability and speed. Every part of a session was audited and tested in a real terminal; this release fixes what turned up.

- **Undo is safer.**
  - `/undo` reverts only what Darce's step changed. Edits you made since, and files you created, are left alone, and the undo message lists what was kept.
  - A `git commit` or `git add` Darce ran is undone too: the branch moves back, and the staging area is restored.
  - Undo restores ignored files like `.env` that a shell command moved or changed.
  - Files undo removes go to `.git/darce-trash` for 7 days instead of being deleted.
  - Outside a git repository, undo says why it can't reverse a shell command, instead of skipping past it.
  - Binary files are restored byte for byte.
- **No more freezes in big repos.**
  - Snapshots run in the background and reuse git's cache: about 0.2s a step where they used to freeze the screen for 1.5s.
  - Launch shows the prompt right away.
  - Untracked files over 25 MB are no longer copied into `.git` on every step.
- **Lighter streaming.** Long code blocks no longer re-highlight on every frame, and the live answer stays within the screen height. In a measured run, that meant 3× less CPU and 5× less terminal output.
- **Shell commands behave.**
  - A timeout or Esc stops the whole command, including anything it started.
  - `cmd &` no longer hangs the turn, and the background job keeps running.
  - Output is capped, so a runaway command can't crash Darce.
- **Sessions recover.**
  - A tool call cut off mid-stream, a dropped connection, or a server error mid-answer used to leave a session that failed every request. These are now repaired, and resumed sessions are repaired too.
  - Server errors (5xx) are retried.
  - Session files are written atomically, and the session list no longer re-reads every past session.
- **Input.**
  - Enter is no longer lost when it arrives in the same keystroke batch as your text (slow frames, SSH, dictation).
  - Two approval prompts at once no longer hang the turn.
  - Ctrl+C twice always exits, even mid-step.
- **Safer defaults.**
  - Deleting branches or tags, rewriting remotes, `git reset`, `commit --amend` and `rebase` now ask first.
  - `git push --delete`, `--mirror` and `:branch` are never covered by "always allow".
- **Edits and reads.** Edit refuses files that aren't UTF-8 instead of corrupting them, and handles CRLF files. Read caps huge lines, and says so for binary files and directories.
- **Config is protected.** A broken `~/.darcerc` is never overwritten (which used to wipe your key). Darce says what's wrong and keeps a copy.
- **Clean exits.** Headless Chrome from `/taste`, voice clips, and ports from `/brain` and `/taste` are cleaned up. Sign-in and sign-up calls time out with a readable error instead of hanging.
- Runs on Node 22.0 again; every command failed there before.

## 0.15.1

- **The taste studio stays on the page after a fix**, so the before/after is the first thing you see, and the empty status line no longer shows before Darce has said anything.
- `darce --help` describes Darce without the marketing filler the taste check flags.

## 0.15.0

- **Taste studio.** `/taste` renders your app in Chrome (desktop and phone width) and opens a window with numbered pins on what reads as templated: purple or rainbow gradients, gradient headlines, emoji standing in for icons, colored side stripes, glow blobs, filler copy and unproven claims (word list based on no-ai-slop), and Tailwind's stock palette used unchanged. Each pin points to the file and line it comes from, including copy that lives in data files.
- **System and code views.** The System tab shows the page's palette, type scale, corner radii and typefaces as rendered. The Code tab finds class lists pasted in many places, colors typed out across files, and components carrying a whole screen of state.
- **Fix from the window.** Choose Fix or Keep for each item. Darce fixes the chosen ones, the window shows each step as it happens and asks for approvals in place, then shows a before/after slider. Keeps are remembered in `.darce/taste.json`.
- **Taste check on edits.** When Darce writes UI, the lines it added are checked and anything that reads as generated goes back to it in the same step, so it fixes its own work. `/taste off` turns this off.

## 0.14.2

- **Security fixes.** Dropped a file-matching dependency with a known denial-of-service bug (Darce now uses `git ls-files` and a lighter matcher), updated esbuild, and hardened how web search results and Markdown are cleaned up.

## 0.14.1

- **Darce lives at darce.dev now.** Sign-in, the dashboard, password reset and every link in the CLI point there. Old cli.darce.dev links still redirect.
- **Password reset from the sign-in screen.** A wrong password now points you to the reset page.

## 0.14.0

- **Usage instead of request counts.** Plans now have an allowance measured by what your model calls actually cost: Free resets every day, Builder and Power every week. Fast models stretch it much further, so a free account gets real daily use. The welcome card and `/account` show how much you've used and when it resets, and Darce stops retrying once it's used up.
- **Claude Haiku 5.5 is the default.** Fast, capable and the cheapest strong model, so your allowance goes furthest. It's also on the Shift+↑/↓ gear list. Your own `/model` choice is kept.
- **The free plan is called Free** everywhere, and the trial and sign-up screens describe the daily allowance.
- **Quieter WHY notes** on short answers, and shorter paths in the welcome card.

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
