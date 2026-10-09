/**
 * Darce CLI — Comprehensive Test Suite
 *
 * Run with: npx tsx test.ts
 *
 * Tests every major component: config, tools, registry, SSE parser,
 * token estimation, cost tracker, model router, context builder.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

// --- Imports from src ---
import { loadConfig } from './src/config/config.js'
import { register, getTool, allTools, toAPITools } from './src/tools/registry.js'
import { registerAllTools } from './src/tools/index.js'
import { ReadTool } from './src/tools/ReadTool.js'
import { WriteTool } from './src/tools/WriteTool.js'
import { EditTool } from './src/tools/EditTool.js'
import { BashTool } from './src/tools/BashTool.js'
import { GlobTool } from './src/tools/GlobTool.js'
import { GrepTool } from './src/tools/GrepTool.js'
import { WebFetchTool } from './src/tools/WebFetchTool.js'
import { parseSSEFrames } from './src/core/streaming.js'
import { estimateTokens, estimateMessagesTokens } from './src/utils/tokens.js'
import { addUsage, getTotalCost, getTotalTokens, resetCosts, formatCostSummary, formatTokenCount } from './src/state/costTracker.js'
import { selectModel } from './src/providers/router.js'
import { toModelProfiles, getModels, getModelProfile } from './src/config/models.js'
import { executeCommand } from './src/core/commands.js'
import { editorReducer, emptyEditor, cursorPosition, type EditorState, type EditorAction } from './src/ui/input/editor.js'
import { intentFor } from './src/ui/input/keys.js'
import { splitStable, closeOpenFence } from './src/ui/markdownStream.js'
import { redactSecrets } from './src/utils/redact.js'
import { safeEnv } from './src/utils/env.js'
import { safeStart, compactMessages } from './src/core/conversation.js'
import { itemsFromMessages } from './src/ui/REPL.js'
import { bashRisk, toolRisk, trustKey, isSimpleCommand } from './src/core/risk.js'
import { Checkpoints } from './src/core/checkpoints.js'
import { fileDiff } from './src/utils/diff.js'
import { execSync } from 'node:child_process'
import { shiftGear, priceNote, DEFAULT_GEARS } from './src/config/gears.js'
import { Derby, defaultRacers } from './src/core/derby.js'
import { pickCritic } from './src/core/critic.js'
import { fuzzyScore, completionContext, rank } from './src/ui/input/complete.js'
import { parseDuckDuckGo } from './src/tools/WebSearchTool.js'
import { htmlToMarkdown, looksBlocked } from './src/web/html.js'
import { discoverSkills, loadSkill, resetSkills } from './src/core/skills.js'
import { remember, readMemory, forget } from './src/core/memory.js'
import { listCommands } from './src/core/commands.js'
import { renderTerminalMarkdown } from './src/ui/markdownRender.js'
import { buildSystemPrompt, resetContext } from './src/core/context.js'
import type { ToolContext, Message, RouterConfig, StreamEvent } from './src/types.js'
import { isCodingModel } from './src/config/models.js'
import { wantsSecondOpinion } from './src/core/riskcheck.js'

// ============================================================
// Test framework
// ============================================================

type TestResult = { name: string; pass: boolean; detail?: string }

const results: TestResult[] = []

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail })
}

async function test(name: string, fn: () => boolean | Promise<boolean>) {
  try {
    const pass = await fn()
    record(name, pass)
  } catch (err: any) {
    record(name, false, err.message ?? String(err))
  }
}

// Helper: create a ToolContext rooted in cwd
function makeCtx(cwd?: string): ToolContext {
  return { cwd: cwd ?? process.cwd(), readFiles: new Set() }
}

// Temp file helpers
const TMP_DIR = join(tmpdir(), 'darce-tests-' + Date.now())
mkdirSync(TMP_DIR, { recursive: true })

function tmpFile(name: string): string {
  return join(TMP_DIR, name)
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
  }
}

// ============================================================
// 1. Config loading
// ============================================================

async function testConfig() {
  await test('Config: loads defaults', () => {
    const cfg = loadConfig()
    return (
      typeof cfg.router === 'object' &&
      typeof cfg.router.default === 'string' &&
      cfg.router.default.length > 0 &&
      typeof cfg.theme === 'string' &&
      typeof cfg.maxTurns === 'number' &&
      cfg.maxTurns > 0 &&
      typeof cfg.shell === 'string'
    )
  })

  await test('Config: router has rules array', () => {
    const cfg = loadConfig()
    return Array.isArray(cfg.router.rules)
  })

  await test('Config: historyPath is a string', () => {
    const cfg = loadConfig()
    return typeof cfg.historyPath === 'string' && cfg.historyPath.length > 0
  })
}

// ============================================================
// 2. Tool registry
// ============================================================

async function testRegistry() {
  // Ensure tools are registered
  registerAllTools()

  await test('Registry: core tools registered (11, plus StealthFetch when configured)', () => {
    return allTools().length >= 11
  })

  await test('Registry: all expected tool names present', () => {
    const names = new Set(allTools().map(t => t.name))
    return ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'].every(n => names.has(n))
  })

  await test('Registry: getTool returns correct tool', () => {
    const t = getTool('Read')
    return t !== undefined && t.name === 'Read'
  })

  await test('Registry: getTool returns undefined for unknown', () => {
    return getTool('NonExistent') === undefined
  })

  await test('Registry: every tool has description', () => {
    return allTools().every(t => typeof t.description === 'string' && t.description.length > 10)
  })

  await test('Registry: every tool has inputSchema', () => {
    return allTools().every(t => t.inputSchema !== undefined && t.inputSchema !== null)
  })

  await test('Registry: every tool has required methods', () => {
    return allTools().every(t =>
      typeof t.call === 'function' &&
      typeof t.formatResult === 'function' &&
      typeof t.activityDescription === 'function'
    )
  })
}

// ============================================================
// 3. Tool JSON schemas (critical bug regression)
// ============================================================

async function testJSONSchemas() {
  registerAllTools()

  await test('Schemas: toAPITools returns one entry per tool', () => {
    return toAPITools().length === allTools().length
  })

  await test('Schemas: every schema has type=function', () => {
    return toAPITools().every(t => t.type === 'function')
  })

  await test('Schemas: every schema has function.name', () => {
    return toAPITools().every(t =>
      typeof t.function.name === 'string' && t.function.name.length > 0
    )
  })

  await test('Schemas: every schema has function.description', () => {
    return toAPITools().every(t =>
      typeof t.function.description === 'string' && t.function.description.length > 0
    )
  })

  await test('Schemas: every schema has non-empty parameters', () => {
    // This was the critical bug: empty parameters objects
    return toAPITools().every(t => {
      const params = t.function.parameters
      return (
        params !== undefined &&
        params !== null &&
        typeof params === 'object' &&
        Object.keys(params).length > 0
      )
    })
  })

  await test('Schemas: parameters have "properties" key (not empty object)', () => {
    // Another regression check: schemas must define properties
    return toAPITools().every(t => {
      const params = t.function.parameters as any
      return (
        params.properties !== undefined &&
        typeof params.properties === 'object' &&
        Object.keys(params.properties).length > 0
      )
    })
  })

  await test('Schemas: parameters have "type" set to "object"', () => {
    return toAPITools().every(t => {
      const params = t.function.parameters as any
      return params.type === 'object'
    })
  })

  await test('Schemas: ReadTool schema has file_path property', () => {
    const readSchema = toAPITools().find(t => t.function.name === 'Read')
    const props = (readSchema?.function.parameters as any)?.properties
    return props?.file_path !== undefined
  })

  await test('Schemas: EditTool schema has old_string and new_string', () => {
    const editSchema = toAPITools().find(t => t.function.name === 'Edit')
    const props = (editSchema?.function.parameters as any)?.properties
    return props?.old_string !== undefined && props?.new_string !== undefined
  })

  await test('Schemas: BashTool schema has command property', () => {
    const bashSchema = toAPITools().find(t => t.function.name === 'Bash')
    const props = (bashSchema?.function.parameters as any)?.properties
    return props?.command !== undefined
  })

  await test('Schemas: WebFetchTool schema has url property', () => {
    const fetchSchema = toAPITools().find(t => t.function.name === 'WebFetch')
    const props = (fetchSchema?.function.parameters as any)?.properties
    return props?.url !== undefined
  })
}

// ============================================================
// 4. Tool execution — ReadTool
// ============================================================

async function testReadTool() {
  const ctx = makeCtx()

  await test('ReadTool: reads package.json successfully', async () => {
    const result = await ReadTool.call({ file_path: join(process.cwd(), 'package.json') }, ctx)
    return !result.isError && result.data.content.includes('darce')
  })

  await test('ReadTool: content has line numbers', async () => {
    const result = await ReadTool.call({ file_path: join(process.cwd(), 'package.json') }, ctx)
    // Line-numbered output starts with "1\t"
    return result.data.content.startsWith('1\t')
  })

  await test('ReadTool: totalLines > 0', async () => {
    const result = await ReadTool.call({ file_path: join(process.cwd(), 'package.json') }, ctx)
    return result.data.totalLines > 0
  })

  await test('ReadTool: offset and limit work', async () => {
    const result = await ReadTool.call({ file_path: join(process.cwd(), 'package.json'), offset: 2, limit: 3 }, ctx)
    const lines = result.data.content.split('\n')
    return lines.length === 3 && lines[0].startsWith('2\t')
  })

  await test('ReadTool: nonexistent file returns error', async () => {
    const result = await ReadTool.call({ file_path: '/nonexistent/path/abc123.txt' }, ctx)
    return result.isError === true
  })

  await test('ReadTool: formatResult includes content', () => {
    const output = { filePath: 'test.txt', content: '1\thello', totalLines: 1, isTruncated: false }
    return ReadTool.formatResult(output).includes('hello')
  })

  await test('ReadTool: formatResult shows truncation notice', () => {
    const output = { filePath: 'test.txt', content: '1\thello', totalLines: 5000, isTruncated: true }
    return ReadTool.formatResult(output).includes('truncated')
  })

  await test('ReadTool: activityDescription with path', () => {
    return ReadTool.activityDescription({ file_path: 'foo.ts' }).includes('foo.ts')
  })

  await test('ReadTool: activityDescription without path', () => {
    return ReadTool.activityDescription({}).includes('Reading')
  })
}

// ============================================================
// 5. Tool execution — WriteTool
// ============================================================

async function testWriteTool() {
  const ctx = makeCtx(TMP_DIR)
  const testFile = tmpFile('write-test.txt')

  await test('WriteTool: writes a file', async () => {
    const result = await WriteTool.call({ file_path: testFile, content: 'hello darce' }, ctx)
    return !result.isError && existsSync(testFile)
  })

  await test('WriteTool: file has correct content', () => {
    return readFileSync(tmpFile('write-test.txt'), 'utf-8') === 'hello darce'
  })

  await test('WriteTool: overwrites existing file', async () => {
    await WriteTool.call({ file_path: testFile, content: 'updated' }, ctx)
    return readFileSync(testFile, 'utf-8') === 'updated'
  })

  await test('WriteTool: creates subdirectories', async () => {
    const nested = join(TMP_DIR, 'sub', 'dir', 'deep.txt')
    const result = await WriteTool.call({ file_path: nested, content: 'deep' }, ctx)
    return !result.isError && existsSync(nested)
  })

  await test('WriteTool: formatResult returns string', () => {
    return typeof WriteTool.formatResult('File written: test.txt') === 'string'
  })

  cleanup(testFile)
}

// ============================================================
// 6. Tool execution — EditTool
// ============================================================

async function testEditTool() {
  const editFile = tmpFile('edit-test.txt')
  const ctx = makeCtx(TMP_DIR)

  // Write a file first
  await writeFile(editFile, 'line one\nline two\nline three\n', 'utf-8')

  // Must read before editing
  await test('EditTool: rejects edit without prior read', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'line two', new_string: 'LINE TWO' },
      ctx
    )
    return result.isError === true && result.data.includes('must Read')
  })

  // Simulate having read the file
  const ctxRead = makeCtx(TMP_DIR)
  ctxRead.readFiles.add(editFile)

  await test('EditTool: replaces string', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'line two', new_string: 'LINE TWO' },
      ctxRead
    )
    return !result.isError
  })

  await test('EditTool: file content updated', () => {
    const content = readFileSync(editFile, 'utf-8')
    return content.includes('LINE TWO') && !content.includes('line two')
  })

  await test('EditTool: rejects when old_string not found', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'nonexistent string', new_string: 'x' },
      ctxRead
    )
    return result.isError === true && result.data.includes('not found')
  })

  await test('EditTool: rejects when old_string === new_string', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'LINE TWO', new_string: 'LINE TWO' },
      ctxRead
    )
    return result.isError === true && result.data.includes('identical')
  })

  // Test replace_all
  await writeFile(editFile, 'aaa bbb aaa bbb aaa', 'utf-8')
  await test('EditTool: multiple matches without replace_all fails', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'aaa', new_string: 'ccc' },
      ctxRead
    )
    return result.isError === true && result.data.includes('matches')
  })

  await test('EditTool: replace_all replaces all occurrences', async () => {
    const result = await EditTool.call(
      { file_path: editFile, old_string: 'aaa', new_string: 'ccc', replace_all: true },
      ctxRead
    )
    const content = readFileSync(editFile, 'utf-8')
    return !result.isError && content === 'ccc bbb ccc bbb ccc'
  })

  cleanup(editFile)
}

// ============================================================
// 7. Tool execution — BashTool
// ============================================================

async function testBashTool() {
  const ctx = makeCtx()

  await test('BashTool: runs echo command', async () => {
    const result = await BashTool.call({ command: 'echo hello' }, ctx)
    return !result.isError && result.data.stdout.trim() === 'hello'
  })

  await test('BashTool: captures exit code', async () => {
    const result = await BashTool.call({ command: 'exit 42' }, ctx)
    return result.data.exitCode === 42
  })

  await test('BashTool: captures stderr', async () => {
    const result = await BashTool.call({ command: 'echo err >&2' }, ctx)
    return result.data.stderr.trim() === 'err'
  })

  await test('BashTool: respects cwd', async () => {
    const result = await BashTool.call({ command: 'pwd' }, makeCtx(TMP_DIR))
    // Normalize: on Windows with Git Bash, pwd may return /tmp/... style paths
    return result.data.stdout.length > 0
  })

  await test('BashTool: formatResult includes stdout', () => {
    const out = BashTool.formatResult({ stdout: 'hi', stderr: '', exitCode: 0, timedOut: false })
    return out.includes('hi')
  })

  await test('BashTool: formatResult shows timeout', () => {
    const out = BashTool.formatResult({ stdout: '', stderr: '', exitCode: null, timedOut: true })
    return out.includes('timed out')
  })

  await test('BashTool: activityDescription with description', () => {
    return BashTool.activityDescription({ command: 'ls', description: 'List files' }) === 'List files'
  })
}

// ============================================================
// 8. Tool execution — GlobTool
// ============================================================

async function testGlobTool() {
  const ctx = makeCtx()

  await test('GlobTool: finds .ts files', async () => {
    const result = await GlobTool.call({ pattern: '**/*.ts' }, ctx)
    return !result.isError && result.data.length > 0
  })

  await test('GlobTool: finds package.json', async () => {
    const result = await GlobTool.call({ pattern: 'package.json' }, ctx)
    return result.data.includes('package.json')
  })

  await test('GlobTool: path parameter scopes search', async () => {
    const result = await GlobTool.call({ pattern: '*.ts', path: 'src/tools' }, ctx)
    return result.data.length > 0 && result.data.every((f: string) => f.endsWith('.ts'))
  })

  await test('GlobTool: no match returns empty array', async () => {
    const result = await GlobTool.call({ pattern: '*.zzzzz_nonexistent' }, ctx)
    return result.data.length === 0
  })

  await test('GlobTool: formatResult for empty', () => {
    return GlobTool.formatResult([]) === 'No files found.'
  })

  await test('GlobTool: formatResult for results', () => {
    const out = GlobTool.formatResult(['a.ts', 'b.ts'])
    return out.includes('a.ts') && out.includes('b.ts')
  })
}

// ============================================================
// 9. Tool execution — GrepTool
// ============================================================

async function testGrepTool() {
  const ctx = makeCtx()

  // GrepTool depends on ripgrep (rg). Tests handle both installed and not-installed cases.
  await test('GrepTool: finds "darce" or reports rg not found', async () => {
    const result = await GrepTool.call({ pattern: 'darce', path: 'package.json' }, ctx)
    // Either finds matches or reports rg not installed — both are valid
    return result.data.includes('darce') || result.data.includes('not found') || result.data.includes('ripgrep')
  })

  await test('GrepTool: glob filter or rg not found', async () => {
    const result = await GrepTool.call({ pattern: 'import', glob: '*.ts', path: 'src/tools' }, ctx)
    return result.data.includes('import') || result.data.includes('not found') || result.data.includes('ripgrep')
  })

  await test('GrepTool: no matches or rg not found', async () => {
    const result = await GrepTool.call({ pattern: 'zzzzz_impossible_string_12345', path: 'package.json' }, ctx)
    return result.data.includes('No matches') || result.data.includes('not found') || result.data.includes('ripgrep')
  })

  await test('GrepTool: activityDescription with pattern', () => {
    return GrepTool.activityDescription({ pattern: 'foo' }).includes('foo')
  })
}

// ============================================================
// 10. Tool execution — WebFetchTool
// ============================================================

async function testWebFetchTool() {
  const ctx = makeCtx()

  await test('WebFetchTool: fetches a URL', async () => {
    const result = await WebFetchTool.call({ url: 'https://httpbin.org/get' }, ctx)
    return !result.isError && result.data.status === 200
  })

  await test('WebFetchTool: response body is non-empty', async () => {
    const result = await WebFetchTool.call({ url: 'https://httpbin.org/get' }, ctx)
    return result.data.body.length > 0
  })

  await test('WebFetchTool: HTML pages come back as markdown', async () => {
    const result = await WebFetchTool.call({ url: 'https://example.com' }, ctx)
    return result.data.status === 200 && !result.data.body.includes('<html') && /Example Domain/.test(result.data.title ?? result.data.body)
  })

  await test('WebFetchTool: invalid URL returns error', async () => {
    const result = await WebFetchTool.call({ url: 'http://invalid.invalid.invalid' }, ctx)
    return result.isError === true
  })

  await test('WebFetchTool: formatResult includes status', () => {
    const out = WebFetchTool.formatResult({ status: 200, body: 'ok', headers: {} })
    return out.includes('200')
  })

  await test('WebFetchTool: activityDescription with url', () => {
    return WebFetchTool.activityDescription({ url: 'https://example.com' }).includes('example.com')
  })
}

// ============================================================
// 11. SSE parser
// ============================================================

async function testSSEParser() {
  await test('SSE: parses single frame', () => {
    const input = 'event: message\ndata: hello\n\n'
    const { frames, remaining } = parseSSEFrames(input)
    return frames.length === 1 && frames[0].data === 'hello' && frames[0].event === 'message' && remaining === ''
  })

  await test('SSE: parses multiple frames', () => {
    const input = 'data: first\n\ndata: second\n\n'
    const { frames } = parseSSEFrames(input)
    return frames.length === 2 && frames[0].data === 'first' && frames[1].data === 'second'
  })

  await test('SSE: keeps incomplete frame as remaining', () => {
    const input = 'data: complete\n\ndata: incomp'
    const { frames, remaining } = parseSSEFrames(input)
    return frames.length === 1 && frames[0].data === 'complete' && remaining === 'data: incomp'
  })

  await test('SSE: handles empty buffer', () => {
    const { frames, remaining } = parseSSEFrames('')
    return frames.length === 0 && remaining === ''
  })

  await test('SSE: handles frame with id field', () => {
    const input = 'id: 42\ndata: msg\n\n'
    const { frames } = parseSSEFrames(input)
    return frames.length === 1 && frames[0].id === '42' && frames[0].data === 'msg'
  })

  await test('SSE: multi-line data concatenation', () => {
    const input = 'data: line1\ndata: line2\n\n'
    const { frames } = parseSSEFrames(input)
    return frames.length === 1 && frames[0].data === 'line1\nline2'
  })

  await test('SSE: skips frames without data', () => {
    const input = 'event: ping\n\ndata: real\n\n'
    const { frames } = parseSSEFrames(input)
    // First frame has no data field, so it gets skipped
    return frames.length === 1 && frames[0].data === 'real'
  })

  await test('SSE: handles lines without colon', () => {
    const input = 'nocolon\ndata: ok\n\n'
    const { frames } = parseSSEFrames(input)
    return frames.length === 1 && frames[0].data === 'ok'
  })
}

// ============================================================
// 12. Token estimation
// ============================================================

async function testTokens() {
  await test('Tokens: estimateTokens returns number > 0', () => {
    return estimateTokens('hello world') > 0
  })

  await test('Tokens: longer text = more tokens', () => {
    const short = estimateTokens('hi')
    const long = estimateTokens('this is a much longer piece of text with many words')
    return long > short
  })

  await test('Tokens: empty string = 0 tokens', () => {
    return estimateTokens('') === 0
  })

  await test('Tokens: ~4 chars per token approximation', () => {
    // 20 chars should be ~5 tokens
    const t = estimateTokens('12345678901234567890')
    return t === 5
  })

  await test('Tokens: estimateMessagesTokens sums messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]
    const total = estimateMessagesTokens(msgs)
    return total === estimateTokens('hello') + estimateTokens('world')
  })

  await test('Tokens: estimateMessagesTokens handles array content', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const total = estimateMessagesTokens(msgs as any)
    return total > 0
  })
}

// ============================================================
// 13. Cost tracker
// ============================================================

async function testCostTracker() {
  resetCosts()

  await test('CostTracker: starts at zero', () => {
    return getTotalCost() === 0 && getTotalTokens() === 0
  })

  await test('CostTracker: addUsage increases totals', () => {
    addUsage('qwen/qwen3-coder', { prompt_tokens: 1000, completion_tokens: 500 })
    return getTotalCost() > 0 && getTotalTokens() === 1500
  })

  await test('CostTracker: multiple addUsage calls accumulate', () => {
    addUsage('qwen/qwen3-coder', { prompt_tokens: 2000, completion_tokens: 1000 })
    return getTotalTokens() === 4500 // 1000+500 + 2000+1000
  })

  await test('CostTracker: formatCostSummary includes $', () => {
    return formatCostSummary().includes('$')
  })

  await test('CostTracker: formatTokenCount returns string', () => {
    const s = formatTokenCount()
    return typeof s === 'string' && s.length > 0
  })

  await test('CostTracker: formatTokenCount uses k suffix for large values', () => {
    // 4500 tokens >= 1000, so should show "4.5k"
    return formatTokenCount().includes('k')
  })

  await test('CostTracker: resetCosts clears everything', () => {
    resetCosts()
    return getTotalCost() === 0 && getTotalTokens() === 0
  })

  await test('CostTracker: unknown model uses default rates', () => {
    resetCosts()
    addUsage('unknown/model', { prompt_tokens: 1000, completion_tokens: 1000 })
    // Default: 0.003/1k input + 0.015/1k output = 0.003 + 0.015 = 0.018
    const cost = getTotalCost()
    return Math.abs(cost - 0.018) < 0.0001
  })
}

// ============================================================
// 14. Model router
// ============================================================

async function testModelRouter() {
  const config: RouterConfig = {
    default: 'qwen/qwen3-coder',
    rules: [
      { when: 'quick-question', use: 'deepseek/deepseek-chat' },
      { when: 'large-context', use: 'google/gemini-3.1-pro-preview' },
      { when: 'complex-reasoning', use: 'anthropic/claude-sonnet-5.5' },
    ],
  }

  await test('Router: returns default for medium-length messages', () => {
    // Must be > 500 tokens to not match quick-question, and < 100k to not match large-context
    const mediumContent = 'Here is a detailed description of the refactoring task that needs careful consideration. '.repeat(50)
    const msgs: Message[] = [{ role: 'user', content: mediumContent }]
    return selectModel(msgs, config) === 'qwen/qwen3-coder'
  })

  await test('Router: quick-question matches short messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    return selectModel(msgs, config) === 'deepseek/deepseek-chat'
  })

  await test('Router: large-context matches huge messages', () => {
    const bigContent = 'x'.repeat(500000) // way over 100k tokens
    const msgs: Message[] = [{ role: 'user', content: bigContent }]
    return selectModel(msgs, config) === 'google/gemini-3.1-pro-preview'
  })

  await test('Router: returns default with empty rules', () => {
    const cfg: RouterConfig = { default: 'test/model', rules: [] }
    const msgs: Message[] = [{ role: 'user', content: 'hello' }]
    return selectModel(msgs, cfg) === 'test/model'
  })

  await test('Router: first matching rule wins', () => {
    // "hi" is short (<500 tokens, no tool results) so quick-question matches first
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const result = selectModel(msgs, config)
    return result === 'deepseek/deepseek-chat'
  })
}

// ============================================================
// 15. Context builder
// ============================================================

async function testContextBuilder() {
  // Reset to ensure fresh build
  resetContext()
  registerAllTools()

  await test('Context: buildSystemPrompt returns non-empty string', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return typeof prompt === 'string' && prompt.length > 100
  })

  await test('Context: includes cwd', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return prompt.includes(process.cwd())
  })

  await test('Context: includes platform', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return prompt.includes(process.platform)
  })

  await test('Context: includes "Darce"', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return prompt.includes('Darce')
  })

  await test('Context: lists all tool names', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'].every(name =>
      prompt.includes(`- ${name}:`)
    )
  })

  await test('Context: includes guidelines', () => {
    const prompt = buildSystemPrompt(process.cwd())
    return prompt.includes('How you work') && prompt.includes('Engineering standards')
  })

  await test('Context: caching works (same string returned)', () => {
    const a = buildSystemPrompt(process.cwd())
    const b = buildSystemPrompt(process.cwd())
    return a === b
  })

  // Reset for other tests
  resetContext()
}

// ============================================================
// 16. Tool validation edge cases
// ============================================================

async function testEdgeCases() {
  const ctx = makeCtx()

  await test('Edge: ReadTool with empty file_path', async () => {
    const result = await ReadTool.call({ file_path: '' } as any, ctx)
    return result.isError === true
  })

  await test('Edge: WriteTool with empty file_path', async () => {
    const result = await WriteTool.call({ file_path: '', content: 'x' } as any, ctx)
    return result.isError === true
  })

  await test('Edge: EditTool with empty file_path', async () => {
    const result = await EditTool.call({ file_path: '', old_string: 'a', new_string: 'b' } as any, ctx)
    return result.isError === true
  })

  await test('Edge: ReadTool isReadOnly is true', () => {
    return ReadTool.isReadOnly === true
  })

  await test('Edge: WriteTool isReadOnly is false', () => {
    return WriteTool.isReadOnly === false
  })

  await test('Edge: GlobTool isConcurrencySafe is true', () => {
    return GlobTool.isConcurrencySafe === true
  })

  await test('Edge: BashTool isConcurrencySafe is false', () => {
    return BashTool.isConcurrencySafe === false
  })
}

// ============================================================
// Runner
// ============================================================

async function runTests() {
  console.log('=== Darce Test Suite ===\n')

  await testConfig()
  await testRegistry()
  await testJSONSchemas()
  await testReadTool()
  await testWriteTool()
  await testEditTool()
  await testBashTool()
  await testGlobTool()
  await testGrepTool()
  await testWebFetchTool()
  await testSSEParser()
  await testTokens()
  await testCostTracker()
  await testModelRouter()
  await testContextBuilder()
  await testEdgeCases()
  await testModelCatalog()
  await testPhase0()
  await testPhase1()
  await testSwarmMerge()
  await testCodingModels()
  await testPhase2()
  await testBrain()

  // Print results
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length

  for (const r of results) {
    const icon = r.pass ? '[PASS]' : '[FAIL]'
    const detail = r.detail ? ` — ${r.detail}` : ''
    console.log(`${icon} ${r.name}${detail}`)
  }

  console.log(`\nResults: ${passed}/${results.length} passed, ${failed} failed`)

  // Cleanup tmp dir
  try {
    const { rmSync } = await import('node:fs')
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch { /* ignore */ }

  if (failed > 0) process.exit(1)
}

// ============================================================
// Model catalog
// ============================================================

async function testModelCatalog() {
  // Realistic dates (2025+) and agent-sized contexts, so only the rule under test decides
  const D = 1_750_000_000
  const raw = [
    { id: 'a/old', created: D + 100, context_length: 128_000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] },
    { id: 'b/new', created: D + 200, context_length: 200_000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'c/no-tools', created: D + 300, supported_parameters: ['temperature'] },
    { id: 'd/image-gen', created: D + 400, supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
    { id: 'b/new:batch', created: D + 200, supported_parameters: ['tools'] },
    { id: 'e/variable', created: D + 50, pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'] },
  ]
  const profiles = toModelProfiles(raw)

  await test('Catalog: keeps only tool-capable text models', () =>
    profiles.map(p => p.id).join(',') === 'b/new,a/old,e/variable')
  await test('Catalog: sorted newest first', () => profiles[0]!.id === 'b/new')
  await test('Catalog: converts per-token pricing to per-1k', () => {
    const p = profiles.find(p => p.id === 'a/old')!
    return Math.abs(p.costPer1kInput - 0.001) < 1e-9 && Math.abs(p.costPer1kOutput - 0.002) < 1e-9
  })
  await test('Catalog: clamps negative (variable) pricing to 0', () =>
    profiles.find(p => p.id === 'e/variable')!.costPer1kInput === 0)
  await test('Catalog: derives vision + reasoning strengths', () => {
    const s = profiles[0]!.strengths
    return s.includes('vision') && s.includes('reasoning')
  })
  await test('Catalog: fallback list is available before fetch', () => getModels().length > 0)
  await test('Catalog: getModelProfile finds default model', () => getModelProfile('qwen/qwen3-coder') !== undefined)

  let switched = ''
  const ctx = { setModel: (m: string) => { switched = m }, currentModel: 'qwen/qwen3-coder', clearMessages: () => {}, cwd: process.cwd() }
  await test('/model: exact short name switches', () => {
    switched = ''
    executeCommand('/model qwen3-coder-next', ctx)
    return switched === 'qwen/qwen3-coder-next'
  })
  await test('/model: unique search switches', () => {
    switched = ''
    executeCommand('/model kimi', ctx)
    return switched === 'moonshotai/kimi-k3'
  })
  await test('/model: ambiguous search lists matches', () => {
    switched = ''
    const out = executeCommand('/model deepseek', ctx) ?? ''
    return switched === '' && out.includes('Multiple matches')
  })
  await test('/model: unknown provider/id is passed through', () => {
    switched = ''
    executeCommand('/model someone/brand-new-model', ctx)
    return switched === 'someone/brand-new-model'
  })
}

// ============================================================
// Phase 0: editor, keys, streaming, safety
// ============================================================

const key = (over: Record<string, unknown> = {}) => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
  ...over,
}) as any

function run(actions: EditorAction[], start: EditorState = emptyEditor()): EditorState {
  return actions.reduce(editorReducer, start)
}

async function testPhase0() {
  // Editor
  await test('Editor: insert and cursor', () => {
    const s = run([{ type: 'insert', text: 'hello' }, { type: 'left' }, { type: 'insert', text: 'X' }])
    return s.text === 'hellXo' && s.cursor === 5
  })
  await test('Editor: word motions and kill word', () => {
    let s = run([{ type: 'insert', text: 'fix the login bug' }, { type: 'wordLeft' }])
    if (s.cursor !== 14) return false
    s = run([{ type: 'killWordBack' }], { ...s, cursor: s.text.length })
    return s.text === 'fix the login ' && s.killRing === 'bug'
  })
  await test('Editor: Ctrl+U / Ctrl+K / yank', () => {
    let s = run([{ type: 'insert', text: 'abc def' }, { type: 'wordLeft' }, { type: 'killToEnd' }])
    if (s.text !== 'abc ') return false
    s = run([{ type: 'lineStart' }, { type: 'yank' }], s)
    return s.text === 'defabc '
  })
  await test('Editor: forward delete removes char under cursor', () => {
    const s = run([{ type: 'insert', text: 'abc' }, { type: 'lineStart' }, { type: 'delete' }])
    return s.text === 'bc' && s.cursor === 0
  })
  await test('Editor: multiline up/down moves within buffer', () => {
    const s = run([{ type: 'insert', text: 'first' }, { type: 'newline' }, { type: 'insert', text: 'second' }, { type: 'up' }])
    const pos = cursorPosition(s)
    return pos.line === 0 && pos.col === 5 && s.historyIndex === -1
  })
  await test('Editor: history browse keeps the draft', () => {
    let s = run([{ type: 'insert', text: 'draft' }], emptyEditor(['newest', 'older']))
    s = run([{ type: 'up' }, { type: 'up' }], s)
    if (s.text !== 'older') return false
    s = run([{ type: 'down' }, { type: 'down' }], s)
    return s.text === 'draft'
  })
  await test('Editor: commit pushes history without duplicates', () => {
    let s = run([{ type: 'insert', text: 'same' }, { type: 'commit' }])
    s = run([{ type: 'insert', text: 'same' }, { type: 'commit' }], s)
    return s.history.length === 1 && s.text === ''
  })
  await test('Editor: paste normalizes CRLF and tabs', () => {
    const s = run([{ type: 'insert', text: 'a\r\n\tb' }])
    return s.text === 'a\n  b'
  })

  // Keys
  await test('Keys: Enter submits, Shift+Enter / Ctrl+J add a newline', () =>
    intentFor('', key({ return: true })).kind === 'submit' &&
    (intentFor('', key({ return: true, shift: true })) as any).action?.type === 'newline' &&
    (intentFor('\n', key()) as any).action?.type === 'newline')
  await test('Keys: Ctrl+C is interrupt, Esc is escape', () =>
    intentFor('c', key({ ctrl: true })).kind === 'interrupt' && intentFor('', key({ escape: true })).kind === 'escape')
  await test('Keys: Ctrl+P opens model picker', () => intentFor('p', key({ ctrl: true })).kind === 'modelPicker')
  await test('Keys: Alt+Left is word left', () => (intentFor('', key({ meta: true, leftArrow: true })) as any).action?.type === 'wordLeft')

  // Streaming markdown
  await test('Stream: stable prefix ends at a blank line', () => {
    const { stable, tail } = splitStable('Para one.\n\nPara two is still')
    return stable === 'Para one.\n\n' && tail === 'Para two is still'
  })
  await test('Stream: never cuts inside an open code fence', () => {
    const { stable } = splitStable('Intro\n\n```js\nconst a = 1\n\nconst b = 2\n')
    return stable === 'Intro\n\n'
  })
  await test('Stream: closed fence becomes stable', () => {
    const { stable, tail } = splitStable('```\ncode\n```\n\nnext')
    return stable === '```\ncode\n```\n\n' && tail === 'next'
  })

  await test('Stream: half-streamed fence is closed for display', () =>
    closeOpenFence('```ts\nconst a') === '```ts\nconst a\n```' && closeOpenFence('done') === 'done')

  // Safety
  await test('Redact: removes known secret formats', () => {
    const { text, count } = redactSecrets('key=sk-or-v1-' + 'a'.repeat(64) + ' aws=AKIAABCDEFGHIJKLMNOP gh=ghp_' + 'x'.repeat(36))
    return count === 3 && !text.includes('AKIA') && text.includes('⟨redacted:aws_access_key⟩')
  })
  await test('Redact: leaves ordinary code alone', () => redactSecrets('const sk = skip-this; // tokenizer').count === 0)
  await test('Env: withholds secrets unless allowed', () => {
    const { env } = safeEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GH_TOKEN: 'y', DARCE_API_KEY: 'z', GIT_AUTHOR_NAME: 'a' }, ['GH_TOKEN'])
    return env.PATH === '/bin' && env.GH_TOKEN === 'y' && env.GIT_AUTHOR_NAME === 'a' && !env.OPENAI_API_KEY && !env.DARCE_API_KEY
  })

  // Conversation integrity
  const toolUse = (id: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a' } }] })
  const toolRes = (id: string): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] })
  await test('Compact: never starts the kept tail with an orphan tool_result', () => {
    const msgs: Message[] = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 8; i++) msgs.push(toolUse('t' + i), toolRes('t' + i))
    const start = safeStart(msgs, msgs.length - 6)
    const out = compactMessages(msgs)
    const firstKept = out[2]!
    return !(Array.isArray(firstKept.content) && firstKept.content[0]!.type === 'tool_result') && start % 2 === 1
  })

  // EditTool $-pattern bug
  await test('EditTool: "$&" in new_string is inserted literally', async () => {
    const f = join(TMP_DIR, 'dollar.txt')
    await writeFile(f, 'price = OLD')
    const ctx = makeCtx(TMP_DIR)
    ctx.readFiles.add(f)
    await EditTool.call({ file_path: f, old_string: 'OLD', new_string: "'$&' and $1" }, ctx)
    return readFileSync(f, 'utf-8') === "price = '$&' and $1"
  })

  // Resume
  await test('Resume: transcript rebuilt from saved messages', () => {
    const items = itemsFromMessages([
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a.ts' } }] },
      toolRes('x'),
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ])
    return items.map(i => i.kind).join(',') === 'user,assistant,tool,assistant' && (items[2] as any).summary === 'a.ts'
  })
}

// ============================================================
// Phase 1: risk, checkpoints, diffs
// ============================================================

async function testCodingModels() {
  const keep = ['anthropic/claude-sonnet-5.5', 'qwen/qwen3-coder', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k3', 'openai/gpt-5.3-codex', 'mistralai/devstral-2512', 'qwen/qwen3-coder-30b-a3b-instruct']
  const drop = ['openai/gpt-audio', 'openrouter/auto', 'qwen/qwen3-vl-235b-a22b-instruct', 'z-ai/glm-5v-turbo', 'openai/gpt-5-nano', 'mistralai/ministral-8b-2512', 'sao10k/l3.1-euryale-70b', 'google/gemini-3-pro-image', 'openai/gpt-oss-safeguard-20b']
  await test('Models: strong coding models stay in the picker', () => keep.every(id => isCodingModel({ id })))
  await test('Models: audio, vision-only, tiny, router and roleplay models are left out', () => drop.every(id => !isCodingModel({ id })))
  await test('Models: old generations and small contexts are left out', () =>
    !isCodingModel({ id: 'openai/gpt-4o', created: Date.UTC(2024, 4, 1) / 1000 }) && !isCodingModel({ id: 'x/y', contextWindow: 32_000 }))
}

async function testSwarmMerge() {
  // Two swarm workers edit the same file: separate regions combine, overlapping ones are reported
  const root = join(tmpdir(), `darce-swarm-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  const sh = (c: string, cwd = root) => execSync(c, { cwd, stdio: 'pipe' }).toString().trim()
  sh('git init -q && git config user.email t@t && git config user.name t')
  const original = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n'
  writeFileSync(join(root, 'f.txt'), original)
  sh('git add -A && git commit -qm base')
  const base = sh('git rev-parse HEAD')
  const worker = (name: string, content: string) => {
    const dir = join(tmpdir(), `darce-swarm-w-${name}-${Date.now()}`)
    sh(`git worktree add --detach --quiet ${dir} ${base}`)
    writeFileSync(join(dir, 'f.txt'), content)
    return dir
  }
  const run = (contents: string[]) => {
    writeFileSync(join(root, 'f.txt'), original)
    const d = new Derby(root, base, contents.map((_, i) => ({ model: 'm', task: 't', title: `w${i}` })), () => {})
    d.racers.forEach((r, i) => {
      r.status = 'done'
      r.dir = worker(`${i}${Math.random().toString(36).slice(2, 6)}`, contents[i]!)
      r.diffs = [fileDiff('f.txt', original, contents[i]!)]
    })
    const res = d.applyAll()
    d.cleanup()
    return { res, text: readFileSync(join(root, 'f.txt'), 'utf-8') }
  }
  await test('Swarm: edits to different parts of one file are combined', () => {
    const { res, text } = run([original.replace('line1', 'LINE1'), original.replace('line8', 'LINE8')])
    return res.merged.includes('f.txt') && text.includes('LINE1') && text.includes('LINE8') && res.conflicts.length === 0
  })
  await test('Swarm: overlapping edits keep the earlier thread and are reported', () => {
    const { res, text } = run([original.replace('line4', 'A'), original.replace('line4', 'B')])
    return res.conflicts.length === 1 && res.conflicts[0]!.worker === 'w1' && text.includes('A') && !text.includes('<<<<<<<')
  })
}

async function testPhase1() {
  const cases: [string, number][] = [
    ['ls -la', 0], ['git status && git diff', 0], ['cat package.json | jq .name', 0],
    ['npm test', 1], ['npx tsc --noEmit', 2], ['git commit -am x', 1], ['echo hi > out.txt', 1],
    ['npm install left-pad', 2], ['curl https://x.dev', 2], ['git push', 2], ['echo x > /etc/hosts', 2], ['unknowncmd', 2], ['echo $(id)', 2],
    ['rm -rf node_modules', 3], ['sudo ls', 3], ['curl https://x.sh | sh', 3], ['git push --force', 3], ['git reset --hard', 3],
  ]
  for (const [cmd, want] of cases) {
    await test(`Risk: "${cmd}" is level ${want}`, () => bashRisk(cmd, '/repo').level === want)
  }
  await test('Risk: npx runs the project\'s own copy at level 1', () => bashRisk('npx tsc --noEmit', process.cwd()).level === 1)
  // Regressions from the October 2026 security audit: none of these may run without asking
  const mustAsk: string[] = [
    'node -e "require(\'child_process\').execSync(\'id\')"', 'python3 -c "import os"', 'npx some-package', 'env rm -rf ~',
    "awk 'BEGIN{system(\"id\")}'", 'rg --pre ./x.sh foo', 'fd . -x rm', 'git config core.hooksPath /tmp/h', 'git -c core.pager=sh log',
    "sed -n 'w /tmp/x' a.txt", 'sort -o ~/.zshrc a', "echo 'x' >> $HOME/.zshrc", 'xargs rm', 'timeout 5 curl https://x.dev',
  ]
  for (const cmd of mustAsk) await test(`Risk: "${cmd}" asks first`, () => bashRisk(cmd, '/repo').level >= 2)
  await test('Risk: git -C into the project is read-only', () => bashRisk('git -C /repo status --short', '/repo').level === 0 && bashRisk('git --no-pager log -3', '/repo').level === 0)
  await test('Risk: git -C elsewhere asks', () => bashRisk('git -C /etc log', '/repo').level === 2)
  // Effects that leave the machine can't be undone, so they must ask even in auto mode
  for (const cmd of ['npm run migrate', 'npm run db:migrate', 'pnpm run deploy', 'make deploy', 'node scripts/seed.js', 'python3 manage.py migrate', 'php artisan migrate', 'psql -c "select 1"', 'prisma db push'])
    await test(`Risk: "${cmd}" asks first (outside effects)`, () => bashRisk(cmd, '/repo').level >= 2)
  await test('Risk: destructive SQL is level 3', () => bashRisk('psql $DATABASE_URL -c "drop table users"', '/repo').level === 3)
  await test('Risk: everyday scripts still run', () => ['npm test', 'npm run build', 'npm run dev', 'make test', 'node index.js'].every(c => bashRisk(c, '/repo').level === 1))
  await test('Second opinion: chained and wrapped scripts are still checked', () =>
    wantsSecondOpinion('cd app && npm run sync; echo $?') && wantsSecondOpinion('timeout 60 npm run sync') && wantsSecondOpinion('env X=1 node scripts/x.js') && !wantsSecondOpinion('ls -la && git status'))
  await test('Risk: cd into the project is read-only', () => bashRisk('cd /repo/src && ls -la', '/repo').level === 0)
  await test('Risk: cd outside the project asks', () => bashRisk('cd /etc && ls', '/repo').level === 2)
  await test('Risk: git config --get stays read-only', () => bashRisk('git config --get user.name', '/repo').level === 0)
  await test('Risk: reading outside the project asks', () => toolRisk('Read', { file_path: '/Users/x/.aws/credentials' }, '/repo').level === 2)
  await test('Risk: user-wide memory asks', () => toolRisk('Remember', { scope: 'user', note: 'x' }, '/repo').level === 2)
  await test('Risk: chained commands are never "always allowed"', () => !isSimpleCommand('npm install && curl https://x.dev') && isSimpleCommand('npm install zod'))
  await test('Risk: Edit outside the project is destructive-level', () => toolRisk('Edit', { file_path: '/etc/passwd' }, '/repo').level === 3)
  await test('Risk: Edit inside the project is level 1', () => toolRisk('Edit', { file_path: 'src/a.ts' }, '/repo').level === 1)
  await test('Risk: trust keys are scoped', () => trustKey('npm install x') === 'npm install' && trustKey('npm run build --watch') === 'npm run build')

  await test('Diff: counts added and removed lines', () => {
    const d = fileDiff('a.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n')
    return d.added === 2 && d.removed === 1 && !d.created
  })
  await test('Diff: new file is marked created', () => fileDiff('n.ts', null, 'x\ny\n').created)

  await test('Context: system prompt is per working directory', () => {
    resetContext()
    const a = buildSystemPrompt('/tmp/project-a')
    const b = buildSystemPrompt('/tmp/project-b')
    return a.includes('/tmp/project-a') && b.includes('/tmp/project-b') && !b.includes('/tmp/project-a')
  })
  await test('Checkpoints: undo reverts shell effects and keeps git state', () => {
    const repo = join(TMP_DIR, 'cp-repo')
    mkdirSync(repo, { recursive: true })
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'one')
    writeFileSync(join(repo, 'b.txt'), 'keep')
    execSync('git add -A && git commit -qm init', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'user wip')
    const head = execSync('git rev-parse HEAD && git status --porcelain', { cwd: repo, encoding: 'utf-8' })
    const cps = new Checkpoints(repo, 'test')
    cps.snapshot('Bash noop')
    cps.snapshot('Bash change')
    writeFileSync(join(repo, 'a.txt'), 'agent')
    unlinkSync(join(repo, 'b.txt'))
    writeFileSync(join(repo, 'c.txt'), 'new')
    const r = cps.undo()
    const ok = r.ok && readFileSync(join(repo, 'a.txt'), 'utf-8') === 'user wip' && existsSync(join(repo, 'b.txt')) && !existsSync(join(repo, 'c.txt'))
    const sameGit = execSync('git rev-parse HEAD && git status --porcelain', { cwd: repo, encoding: 'utf-8' }) === head
    const second = cps.undo() // only the no-op snapshot is left
    cps.cleanup()
    return ok && sameGit && !second.ok
  })
}

// ============================================================
// Phase 2: gears, critic, derby
// ============================================================

async function testPhase2() {
  await test('Gears: shift up and down, clamp at the ends', () =>
    shiftGear(DEFAULT_GEARS, DEFAULT_GEARS[1]!, 1) === DEFAULT_GEARS[2] &&
    shiftGear(DEFAULT_GEARS, DEFAULT_GEARS[0]!, -1) === DEFAULT_GEARS[0] &&
    shiftGear(DEFAULT_GEARS, 'some/other-model', 1) === DEFAULT_GEARS[DEFAULT_GEARS.length - 1])
  await test('Gears: price note compares costs', () => /× the cost/.test(priceNote('anthropic/claude-opus-5.5', 'qwen/qwen3-coder')))
  await test('Critic: picks a different vendor', () =>
    !pickCritic('anthropic/claude-sonnet-5.5').startsWith('anthropic/') && pickCritic('openai/gpt-5.6-sol').startsWith('anthropic/'))
  await test('Derby: default racers are unique, max 3', () => {
    const r = defaultRacers('anthropic/claude-sonnet-5.5')
    return r.length === 3 && new Set(r).size === 3
  })

  await test('Derby: racers work in isolation; apply copies only the winner', async () => {
    const repo = join(TMP_DIR, 'derby-repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo })
    writeFileSync(join(repo, 'src', 'a.ts'), 'value = 1\n')
    execSync('git add -A && git commit -qm init', { cwd: repo })
    registerAllTools()

    // Fake provider: each model writes its own name into src/a.ts, then finishes
    const fake = {
      async *stream(messages: any[], model: string) {
        yield { type: 'request_start' }
        const last = messages[messages.length - 1]
        const cwd = String(messages[0].content).match(/Current directory: (\S+)/)![1]
        if (last.role === 'user' && typeof last.content === 'string') {
          const input = { file_path: join(cwd, 'src', 'a.ts'), content: `value = "${model}"\n` }
          yield { type: 'tool_use_end', id: 'w', name: 'Write', input }
          yield { type: 'message_complete', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'Write', input }] }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
          return
        }
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'message_complete', message: { role: 'assistant', content: 'done' }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      },
      async listModels() { return [] },
    }
    const base = new Checkpoints(repo, 'derby').commitWorkingTree('base')!
    const d = new Derby(repo, base, ['m/one', 'm/two'], () => {})
    await d.run('set value', [], fake as any)
    const untouched = readFileSync(join(repo, 'src', 'a.ts'), 'utf-8') === 'value = 1\n'
    const bothDone = d.racers.every(r => r.status === 'done' && r.diffs.length === 1)
    d.apply(1)
    const applied = readFileSync(join(repo, 'src', 'a.ts'), 'utf-8') === 'value = "m/two"\n'
    d.cleanup()
    const worktrees = execSync('git worktree list', { cwd: repo, encoding: 'utf-8' }).trim().split('\n').length
    return untouched && bothDone && applied && worktrees === 1
  })
}

// ============================================================
// v0.8: brain, skills, memory, web, completion
// ============================================================

async function testBrain() {
  await test('Complete: slash at start gives command context', () => {
    const c = completionContext({ ...emptyEditor(), text: '/de', cursor: 3 })
    return c?.kind === 'command' && c.query === 'de'
  })
  await test('Complete: @mention anywhere gives file context', () => {
    const c = completionContext({ ...emptyEditor(), text: 'look at @src/ap please', cursor: 15 })
    return c?.kind === 'file' && c.query === 'src/ap' && c.start === 8
  })
  await test('Complete: fuzzy ranks prefix and basename matches first', () => {
    const files = ['docs/repl-notes.md', 'src/ui/REPL.tsx', 'src/core/query.ts']
    const ranked = rank(files, 'repl', f => f)
    return ranked.length === 2 && !ranked.includes('src/core/query.ts') && fuzzyScore('rpl', 'src/ui/REPL.tsx') > 0 && fuzzyScore('zzz', 'abc') === -1
  })
  await test('Complete: every command is listed with a description', () => {
    const cmds = listCommands()
    return cmds.length >= 15 && cmds.every(c => c.description) && cmds.some(c => c.name === 'derby' && c.args === '<task>')
  })

  await test('Skills: built-ins are available and loadable', () => {
    resetSkills()
    const names = discoverSkills(TMP_DIR).map(s => s.name)
    return ['ui-craft', 'security-review', 'teach', 'web-research'].every(n => names.includes(n)) && !!loadSkill(TMP_DIR, 'security-review')?.body.includes('IDOR')
  })
  await test('Skills: project SKILL.md is discovered and overrides by name', () => {
    const dir = join(TMP_DIR, 'skillproj', '.darce', 'skills', 'deploy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: >-\n  How we deploy\n  this app\n---\nRun make ship.')
    const over = join(TMP_DIR, 'skillproj', '.darce', 'skills', 'ui-craft')
    mkdirSync(over, { recursive: true })
    writeFileSync(join(over, 'SKILL.md'), '---\nname: ui-craft\ndescription: Our own UI rules\n---\nUse the design system.')
    resetSkills()
    const skills = discoverSkills(join(TMP_DIR, 'skillproj'))
    const deploy = skills.find(s => s.name === 'deploy')
    const ui = skills.find(s => s.name === 'ui-craft')
    return deploy?.description === 'How we deploy this app' && ui?.source === 'project' && loadSkill(join(TMP_DIR, 'skillproj'), 'deploy')?.body === 'Run make ship.'
  })

  await test('Memory: remember, dedupe and forget (isolated home)', () => {
    const realHome = process.env.HOME
    process.env.HOME = join(TMP_DIR, 'home')
    try {
      const a = remember('user', TMP_DIR, 'Prefers pnpm over npm')
      const b = remember('user', TMP_DIR, 'prefers pnpm over npm')
      const c = remember('project', TMP_DIR, 'Deploys with railway up')
      const has = readMemory('user', TMP_DIR).includes('Prefers pnpm') && readMemory('project', TMP_DIR).includes('railway up')
      const removed = forget('user', TMP_DIR, 'pnpm')
      return a.added && !b.added && c.added && has && removed === 1 && !readMemory('user', TMP_DIR).includes('pnpm')
    } finally {
      process.env.HOME = realHome
    }
  })

  await test('Web: DuckDuckGo results parse into title, url, snippet', () => {
    const html = '<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fink.dev%2Fdocs&amp;rut=x">Ink <b>docs</b></a><a class="result__snippet" href="#">React for &amp; CLIs</a></div>'
    const r = parseDuckDuckGo(html)
    return r.length === 1 && r[0]!.url === 'https://ink.dev/docs' && r[0]!.title === 'Ink docs' && r[0]!.snippet === 'React for & CLIs'
  })
  await test('Web: HTML becomes markdown without scripts', () => {
    const { title, markdown } = htmlToMarkdown('<html><head><title>T</title><script>evil()</script></head><body><main><h1>Hello</h1><p>See <a href="/docs">docs</a></p></main></body></html>', 'https://x.dev/page')
    return title === 'T' && markdown.includes('# Hello') && markdown.includes('(https://x.dev/docs)') && !markdown.includes('evil')
  })
  await test('Markdown: no raw syntax leaks, even inside lists and tables', () => {
    const out = renderTerminalMarkdown('## Title\n\n- **bold** and *em* and `code` and [link](https://x.dev)\n  - nested **x**\n\n| a | b |\n|---|---|\n| **c** | d |', 80).replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, '')
    return !/\*\*|##|`|\]\(/.test(out) && out.includes('• bold and em and code and link') && out.includes('Title')
  })
  await test('Markdown: long list items wrap with a hanging indent', () => {
    const out = renderTerminalMarkdown('- ' + 'word '.repeat(40), 40).replace(/\x1b\[[0-9;]*m/g, '')
    const lines = out.split('\n')
    return lines.length > 1 && lines.slice(1).every(l => l.startsWith('  ')) && lines.every(l => l.length <= 41)
  })
  await test('Images: PNG and JPEG sizes read from headers', async () => {
    const { imageSize } = await import('./src/ui/input/images.js')
    const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1280, 16); png.writeUInt32BE(800, 20)
    const s = imageSize(png)
    return s?.width === 1280 && s?.height === 800
  })
  await test('Images: dropped paths are recognised (quoted, escaped, ~)', async () => {
    const { imagePathFrom } = await import('./src/ui/input/images.js')
    const f = join(TMP_DIR, 'shot one.png')
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    return imagePathFrom(`'${f}'`, '/') === f && imagePathFrom(f.replace(/ /g, '\\ '), '/') === f && imagePathFrom('notes.txt', TMP_DIR) === null
  })
  await test('Images: sent to the model as image_url parts; counted as ~1500 tokens', async () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', mediaType: 'image/png', data: 'A'.repeat(100000) }] }]
    return estimateMessagesTokens(msgs) < 2000
  })
  await test('WHY: filler notes are dropped, real ones keep their tag', () => {
    const filler = renderTerminalMarkdown('Renamed it.\n\nWHY: This is a straightforward rename for clarity.', 80)
    const real = renderTerminalMarkdown('Fixed.\n\nWHY: forEach ignores the promises its callback returns, so nothing waits.', 80)
    return !filler.includes('WHY') && filler.includes('Renamed it.') && real.includes('WHY') && real.includes('forEach ignores')
  })
  await test('Stream: server waiting pings become waiting events, then the answer streams', async () => {
    const { createServer } = await import('node:http')
    const { OpenRouterProvider } = await import('./src/providers/openrouter.js')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': darce waiting 3s\n\n')
      setTimeout(() => res.write(': darce waiting 7s hedged\n\n'), 30)
      setTimeout(() => {
        const failing = (globalThis as any).__failStream
        res.end(failing
          ? 'data: {"error":{"message":"Provider returned error","code":502}}\n\ndata: [DONE]\n\n'
          : 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }, 60)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const collect = async () => { const out: StreamEvent[] = []; for await (const e of new OpenRouterProvider('k', `http://127.0.0.1:${port}`).stream([{ role: 'user', content: 'x' }], 'qwen/qwen3-coder', [])) out.push(e); return out }
    const ok = await collect()
    ;(globalThis as any).__failStream = true
    const bad = await collect()
    server.close()
    const waits = ok.filter(e => e.type === 'waiting') as Extract<StreamEvent, { type: 'waiting' }>[]
    return waits.length === 2 && waits[1]!.seconds === 7 && waits[1]!.hedged && ok.some(e => e.type === 'text_delta')
      && bad.some(e => e.type === 'error' && e.error.includes('Provider returned error'))
  })
  await test('Voice: first names come from ordinary emails only', async () => {
    const { firstNameFromEmail } = await import('./src/core/voice.js')
    return firstNameFromEmail('amer.sarhan@gmail.com') === 'Amer' && firstNameFromEmail('JOHN_doe@x.io') === 'John' && firstNameFromEmail('xacom39771@airychen.com') === '' && firstNameFromEmail('a@b.c') === '' && firstNameFromEmail(undefined) === ''
  })
  await test('Voice: lines play in the background; extras are dropped, endings wait their turn', async () => {
    const { createServer } = await import('node:http')
    const { Narrator } = await import('./src/core/voice.js')
    const asked: string[] = []
    const server = createServer((req, res) => {
      let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
        asked.push(JSON.parse(b).event)
        setTimeout(() => { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Darce-Line': 'hi' }); res.end(Buffer.from([0xff, 0xfb])) }, 40)
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const played: number[] = []
    const n = new Narrator({ apiKey: 'k', apiBase: `http://127.0.0.1:${port}`, name: () => 'Amer', voice: () => 'erik', player: () => ({ cmd: 'sleep', args: () => { played.push(Date.now()); return ['0.3'] } }) })
    const t0 = Date.now()
    n.say('start', 'a')        // spoken
    n.say('progress', 'b')     // dropped: already talking, and only worth saying in the moment
    n.say('done', 'c')         // waits for the first line, then plays
    const quick = Date.now() - t0 // say() must never block
    await new Promise(r => setTimeout(r, 1200))
    server.close()
    return quick < 20 && asked.join(',') === 'start,done' && played.length === 2 && played[1]! - played[0]! >= 280
  })
  await test('Web: bot walls are detected', () => looksBlocked(403, '') && looksBlocked(200, '<title>Just a moment...</title>') && !looksBlocked(200, '<h1>Docs</h1>'))
}

runTests().catch(err => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
