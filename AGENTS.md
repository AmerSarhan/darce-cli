# Working on Darce

Darce is a terminal coding agent (TypeScript, React 19 + Ink 8, Node 22+). Its promise is that `/undo` reverses
everything it did, shell commands included, and that it only asks before things undo can't reverse. Changes here
should keep both true.

## Commands

```bash
npm install
npm run dev            # run from source (tsx)
npm run build          # tsup → dist/ (also copies src/taste/web and src/brain/web)
npm test               # tsx test.ts: the whole suite, about a minute
npx tsc --noEmit -p .  # typecheck
```

`npm publish` runs the build and the tests first. After a build, `node dist/cli.js` runs the real thing.

## Where things are

| Path | What it does |
|---|---|
| `src/entrypoints/cli.tsx` | Arguments, print mode (`-p`), process safety net, renders the REPL |
| `src/ui/REPL.tsx` | The interactive app: input, approvals, streaming, slash commands |
| `src/core/query.ts` | The agent loop: stream a reply, run the tools it asks for, repeat |
| `src/providers/openrouter.ts` | Streaming client for Darce's API (OpenAI-compatible SSE), retries |
| `src/tools/` | Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, Image, Agent, Plan, Skill, Remember |
| `src/core/checkpoints.ts` | Snapshots before and after each step; `/undo`, `/rewind`, `/diff` |
| `src/core/risk.ts` | Scores every tool call: 0 read-only, 1 undoable (runs in auto mode), 2 asks, 3 destructive (always asks) |
| `src/core/conversation.ts` | Compaction and history repair |
| `src/state/sessions.ts` | Saved sessions for `--resume` |
| `src/taste/` | `/taste`: rules for generated-looking UI, headless Chrome capture, the studio window |
| `src/brain/` | `/brain`: live map of the project in the browser |
| `test.ts` | Every test, grouped by area |

## Rules

- **Undo first.** Anything that changes files must go through a tool marked `isReadOnly: false`, so a snapshot is
  taken before it runs. If you add a way to change files or git state, add an undo test in `test.ts` (see the
  `Undo:` tests).
- **Risk rules need tests.** A new or changed rule in `risk.ts` gets a test with the exact command. A false
  "read-only" is a security bug: level 0 runs even in plan mode.
- **Nothing blocks the UI.** No sync git, network or large file work on the render path. Every network call
  needs a timeout. Tool output and anything rendered must be bounded.
- **Tool errors are results.** A tool returns a result with `isError: true`; it never throws into the loop.
- **History stays valid.** Every `tool_use` must get a `tool_result`, or every later request fails.
- **No secrets in logs or output.** Use `redactSecrets`. Config writes go through `writePrivate` (atomic, 0600).

## Style

- Match the code around you: terse, small functions, no new dependencies without a good reason.
- Comments say why, not what.
- User-facing text is plain and specific, in sentence case, with no filler words. `/taste` flags the same
  words in UI copy, so Darce's own copy should pass it.
- Update `CHANGELOG.md` for anything a user would notice.
