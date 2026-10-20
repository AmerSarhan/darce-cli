// Tool and context fixes: second-opinion cache and monorepo scripts, bounded instruction and skill reads,
// Image path checks, Skill size and missing files, malformed search links, BOM frontmatter.
// Temp dirs only, fetch is mocked: no network, no credentials.
import './test-home.js'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { secondOpinion } from './src/core/riskcheck.js'
import { projectInstructions } from './src/core/context.js'
import { discoverSkills, resetSkills } from './src/core/skills.js'
import { ImageTool } from './src/tools/ImageTool.js'
import { SkillTool } from './src/tools/SkillTool.js'
import { WebSearchTool } from './src/tools/WebSearchTool.js'

type Test = (name: string, fn: () => boolean | Promise<boolean>) => Promise<void>

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `darce-0180-${p}-`)))
const ctx = (cwd: string) => ({ cwd, readFiles: new Set<string>() })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** Runs `fn` with fetch replaced, counting calls; the real fetch always comes back. */
async function withFetch<T>(reply: (n: number) => Response, fn: (calls: () => number) => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = (async () => reply(++n)) as typeof fetch
  try { return await fn(() => n) } finally { globalThis.fetch = real }
}

const pngReply = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }] }), { status: 200 })

export async function testTools0180(test: Test) {
  await test('Risk check: an edited package.json script is judged again, not served from the cache', async () => {
    const cwd = tmp('rc')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'node build.js' } }))
    writeFileSync(join(cwd, 'build.js'), 'console.log(1)')
    return withFetch(() => new Response(JSON.stringify({ outside: 0.05 }), { status: 200 }), async () => {
      const first = await secondOpinion('npm run build', cwd, 'test-key', 'https://api.darce.dev')
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'git push --force origin main' } }))
      const second = await secondOpinion('npm run build', cwd, 'test-key', 'https://api.darce.dev')
      return first === null && (second?.level ?? 0) >= 2
    })
  })

  await test('Risk check: an edited script file is sent to Jev again', async () => {
    const cwd = tmp('rc2')
    writeFileSync(join(cwd, 'sync.js'), 'console.log("local")')
    return withFetch(n => new Response(JSON.stringify({ outside: n === 1 ? 0.05 : 0.9 }), { status: 200 }), async calls => {
      const first = await secondOpinion('node sync.js', cwd, 'test-key', 'https://api.darce.dev')
      const cached = await secondOpinion('node sync.js', cwd, 'test-key', 'https://api.darce.dev')
      writeFileSync(join(cwd, 'sync.js'), 'await fetch("https://prod.example/wipe", { method: "DELETE" })')
      const edited = await secondOpinion('node sync.js', cwd, 'test-key', 'https://api.darce.dev')
      return first === null && cached === null && edited?.level === 2 && calls() === 2
    })
  })

  await test('Risk check: `cd web && npm run build` reads web/package.json', async () => {
    const cwd = tmp('mono')
    mkdirSync(join(cwd, 'web'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }))
    writeFileSync(join(cwd, 'web', 'package.json'), JSON.stringify({ scripts: { build: 'git push --force origin main' } }))
    // A non-Darce base never calls Jev, so only the deterministic check can answer
    const r = await secondOpinion('cd web && npm run build', cwd, 'test-key', 'https://openrouter.ai/api')
    const root = await secondOpinion('npm run build', cwd, 'test-key', 'https://openrouter.ai/api')
    return (r?.level ?? 0) >= 2 && root === null
  })

  await test('Instructions: symlinks to /dev/zero or outside the project are skipped; huge files are cut', () => {
    const parent = tmp('ctx')
    const cwd = join(parent, 'proj'); mkdirSync(cwd)
    writeFileSync(join(parent, 'secret.txt'), 'SECRET_OUTSIDE_PROJECT')
    symlinkSync('/dev/zero', join(cwd, 'AGENTS.md'))
    symlinkSync(join(parent, 'secret.txt'), join(cwd, 'CLAUDE.md'))
    writeFileSync(join(cwd, '.cursorrules'), 'x'.repeat(20 * 1024 * 1024))
    const t = Date.now()
    const out = projectInstructions(cwd)
    const all = out.join('\n')
    return Date.now() - t < 2000 && !all.includes('SECRET_OUTSIDE_PROJECT') && !all.includes('From AGENTS.md')
      && all.includes('From .cursorrules') && all.includes('…(truncated)') && all.length < 20_000
  })

  await test('Instructions: a symlink to a file inside the project still works', () => {
    const cwd = tmp('ctx2')
    mkdirSync(join(cwd, 'docs'))
    writeFileSync(join(cwd, 'docs', 'rules.md'), 'Use tabs.')
    symlinkSync(join(cwd, 'docs', 'rules.md'), join(cwd, 'AGENTS.md'))
    return projectInstructions(cwd).some(s => s.includes('Use tabs.'))
  })

  await test('Skills: a SKILL.md linked to /dev/zero or outside the project is skipped', () => {
    const parent = tmp('skz')
    const cwd = join(parent, 'proj')
    writeFileSync(join(parent, 'SKILL.md'), '---\nname: leaked\ndescription: from outside\n---\nSECRET')
    mkdirSync(join(cwd, '.claude', 'skills', 'out'), { recursive: true })
    symlinkSync(join(parent, 'SKILL.md'), join(cwd, '.claude', 'skills', 'out', 'SKILL.md'))
    // The user's own skills may link anywhere, so only the file type protects them
    const own = join(homedir(), '.darce', 'skills', 'zero-0180')
    mkdirSync(own, { recursive: true })
    symlinkSync('/dev/zero', join(own, 'SKILL.md'))
    resetSkills()
    const t = Date.now()
    const names = discoverSkills(cwd).map(s => s.name)
    rmSync(own, { recursive: true, force: true })
    resetSkills()
    return Date.now() - t < 2000 && !names.includes('leaked') && !names.includes('zero-0180')
  })

  await test('Image: empty and "." paths fail before any request', async () => {
    const cwd = join(tmp('img'), 'proj'); mkdirSync(cwd)
    return withFetch(pngReply, async calls => {
      const a = await ImageTool.call({ prompt: 'x', file_path: '' }, ctx(cwd))
      const b = await ImageTool.call({ prompt: 'x', file_path: '.' }, ctx(cwd))
      return !!a.isError && !!b.isError && calls() === 0
    })
  })

  await test('Image: a PNG asked for as .jpg is not renamed; the error names .png', async () => {
    const cwd = tmp('img2')
    writeFileSync(join(cwd, 'hero.png'), 'ORIGINAL')
    return withFetch(pngReply, async () => {
      const r = await ImageTool.call({ prompt: 'x', file_path: 'hero.jpg' }, ctx(cwd))
      return !!r.isError && r.data.includes('.png') && !existsSync(join(cwd, 'hero.jpg')) && readFileSync(join(cwd, 'hero.png'), 'utf-8') === 'ORIGINAL'
    })
  })

  await test('Image: refuses a symlink target and paths outside the project; saves a normal .png', async () => {
    const parent = tmp('img3')
    const cwd = join(parent, 'proj'); mkdirSync(cwd)
    writeFileSync(join(parent, 'victim.txt'), 'IMPORTANT')
    symlinkSync(join(parent, 'victim.txt'), join(cwd, 'logo.png'))
    return withFetch(pngReply, async () => {
      const link = await ImageTool.call({ prompt: 'x', file_path: 'logo.png' }, ctx(cwd))
      const out = await ImageTool.call({ prompt: 'x', file_path: '../escape.png' }, ctx(cwd))
      const ok = await ImageTool.call({ prompt: 'x', file_path: 'public/hero.png' }, ctx(cwd))
      return !!link.isError && !!out.isError && !existsSync(join(parent, 'escape.png'))
        && readFileSync(join(parent, 'victim.txt'), 'utf-8') === 'IMPORTANT'
        && !ok.isError && readFileSync(join(cwd, 'public', 'hero.png')).equals(PNG)
    })
  })

  await test('Skill: a huge body is capped with a pointer to Read', async () => {
    const cwd = tmp('skbig')
    const d = join(cwd, '.claude', 'skills', 'big'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), '---\nname: big\ndescription: huge\n---\n' + 'lorem ipsum '.repeat(2_000_000))
    resetSkills()
    const r = await SkillTool.call({ name: 'big' }, ctx(cwd))
    const text = SkillTool.formatResult(r.data)
    return !r.isError && text.length < 52_000 && text.includes('Use Read on') && text.includes(join(d, 'SKILL.md'))
  })

  await test('Skill: a SKILL.md deleted after discovery is an error result, not a throw', async () => {
    const cwd = tmp('skgone')
    const d = join(cwd, '.darce', 'skills', 'gone'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), '---\nname: gone\ndescription: soon deleted\n---\nbody')
    resetSkills()
    discoverSkills(cwd)
    rmSync(join(d, 'SKILL.md'))
    const r = await SkillTool.call({ name: 'gone' }, ctx(cwd))
    return !!r.isError && r.data.body.includes('gone')
  })

  await test('WebSearch: a malformed result link is skipped, the rest survive', async () => {
    const html = '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.example%2F">Good</a><a class="result__snippet">ok</a></div>'
      + '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.example%2F%E0%A4%A">Bad</a></div>'
    return withFetch(() => new Response(html, { status: 200 }), async () => {
      const r = await WebSearchTool.call({ query: 'x' }, ctx(tmpdir()))
      return !r.isError && r.data.results.length === 1 && r.data.results[0]!.url === 'https://good.example/'
    })
  })

  await test('Skills: frontmatter after a UTF-8 BOM is read', () => {
    const cwd = tmp('bom')
    const d = join(cwd, '.darce', 'skills', 'dir-name'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), '﻿---\nname: bom\ndescription: has a BOM\n---\nbody')
    resetSkills()
    const s = discoverSkills(cwd).find(x => x.source === 'project')
    return s?.name === 'bom' && s.description === 'has a BOM'
  })
}
