# Darce CLI Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a blazing-fast CLI coding agent powered by OpenRouter with smart model routing.

**Architecture:** TypeScript + Ink (React terminal UI) + OpenRouter SSE streaming + Zod tool schemas. Async generator conversation loop, concurrent tool execution, layered config.

**Tech Stack:** TypeScript, Ink 5, React 18, Zod, marked, cli-highlight, globby, tsup

---

### Task 1: Project scaffold + dependencies
### Task 2: Config system (layered .darcerc loading)
### Task 3: Types & message definitions
### Task 4: SSE streaming parser
### Task 5: OpenRouter provider
### Task 6: Tool base type + registry
### Task 7: ReadTool + WriteTool
### Task 8: EditTool (with validation)
### Task 9: BashTool (with streaming)
### Task 10: GlobTool + GrepTool + WebFetchTool
### Task 11: Core query loop (async generator)
### Task 12: Cost tracker
### Task 13: Smart model router
### Task 14: UI — App, Spinner, StatusBar
### Task 15: UI — Markdown + CodeBlock rendering
### Task 16: UI — Messages, Message, streaming text
### Task 17: UI — Prompt (input with history)
### Task 18: UI — REPL (wires everything together)
### Task 19: UI — ModelPicker (Ctrl+M)
### Task 20: Entrypoint (cli.tsx + main.tsx)
### Task 21: Build config (tsup + bin)
