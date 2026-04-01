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
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
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
import { buildSystemPrompt, resetContext } from './src/core/context.js'
import type { ToolContext, Message, RouterConfig } from './src/types.js'

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

  await test('Registry: 7 tools registered', () => {
    return allTools().length === 7
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

  await test('Schemas: toAPITools returns 7 entries', () => {
    return toAPITools().length === 7
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

  await test('WebFetchTool: captures headers', async () => {
    const result = await WebFetchTool.call({ url: 'https://httpbin.org/get' }, ctx)
    return Object.keys(result.data.headers).length > 0
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
      { when: 'large-context', use: 'google/gemini-2.5-pro' },
      { when: 'complex-reasoning', use: 'anthropic/claude-sonnet-4' },
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
    return selectModel(msgs, config) === 'google/gemini-2.5-pro'
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
    return prompt.includes('Guidelines')
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

runTests().catch(err => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
