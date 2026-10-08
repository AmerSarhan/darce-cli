import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BUILTIN_SKILLS } from '../skills/builtin.js'

/**
 * Skills: folders with a SKILL.md (YAML frontmatter `name` + `description`, then
 * instructions). Compatible with the Agent Skills format used by Claude Code, so
 * any skill you already have works in Darce.
 */
export type Skill = {
  name: string
  description: string
  source: 'project' | 'user' | 'claude' | 'plugin' | 'builtin'
  path?: string // SKILL.md path (absent for built-ins)
  body?: string // built-ins carry their body inline
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = m[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (value === '' || value === '|' || value === '>' || value === '>-' || value === '|-') {
      // Block scalar: gather the indented lines that follow
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      value = block.join(' ')
    }
    meta[kv[1]!] = value.replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2]!.trim() }
}

/** Find SKILL.md files up to `depth` levels below a directory. */
function findSkillFiles(root: string, depth: number): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, level: number) => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    if (entries.includes('SKILL.md')) { out.push(join(dir, 'SKILL.md')); return }
    if (level >= depth) return
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue
      const p = join(dir, e)
      try { if (statSync(p).isDirectory()) walk(p, level + 1) } catch {}
    }
  }
  walk(root, 0)
  return out
}

function pluginSkillRoots(): string[] {
  const cache = join(homedir(), '.claude', 'plugins', 'cache')
  const roots: string[] = []
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills
  for (const market of safeList(cache)) {
    for (const plugin of safeList(join(cache, market))) {
      const versions = safeList(join(cache, market, plugin))
      // newest version only
      const latest = versions.map(v => join(cache, market, plugin, v)).sort((a, b) => mtime(b) - mtime(a))[0]
      if (latest) roots.push(join(latest, 'skills'))
    }
  }
  return roots
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir).filter(e => !e.startsWith('.')) } catch { return [] }
}
function mtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

const cache = new Map<string, Skill[]>()

/** All available skills; earlier sources win on name clashes (project overrides user overrides built-in). */
export function discoverSkills(cwd: string): Skill[] {
  const hit = cache.get(cwd)
  if (hit) return hit
  const sources: Array<[Skill['source'], string, number]> = [
    ['project', join(cwd, '.darce', 'skills'), 2],
    ['project', join(cwd, '.claude', 'skills'), 2],
    ['user', join(homedir(), '.darce', 'skills'), 3],
    ['claude', join(homedir(), '.claude', 'skills'), 3],
    ...pluginSkillRoots().map(r => ['plugin', r, 2] as [Skill['source'], string, number]),
  ]
  const seen = new Set<string>()
  const skills: Skill[] = []
  for (const [source, root, depth] of sources) {
    for (const file of findSkillFiles(root, depth)) {
      try {
        const { meta } = parseFrontmatter(readFileSync(file, 'utf-8'))
        const name = (meta.name || dirname(file).split('/').pop() || '').trim()
        if (!name || seen.has(name) || meta['disable-model-invocation'] === 'true') continue
        seen.add(name)
        skills.push({ name, description: (meta.description || '').slice(0, 300), source, path: file })
      } catch {}
    }
  }
  for (const b of BUILTIN_SKILLS) {
    if (seen.has(b.name)) continue
    seen.add(b.name)
    skills.push({ name: b.name, description: b.description, source: 'builtin', body: b.body })
  }
  cache.set(cwd, skills)
  return skills
}

const PROMPT_ORDER: Record<Skill['source'], number> = { project: 0, user: 1, claude: 2, builtin: 3, plugin: 4 }

/** Compact list for the system prompt: your own skills first, plugins last, bounded so it stays cheap. */
export function skillIndex(cwd: string): Skill[] {
  return [...discoverSkills(cwd)]
    .sort((a, b) => PROMPT_ORDER[a.source] - PROMPT_ORDER[b.source])
    .slice(0, 40)
    .map(s => ({ ...s, description: s.description.length > 160 ? `${s.description.slice(0, 157)}…` : s.description }))
}

export function loadSkill(cwd: string, name: string): { name: string; body: string; dir?: string } | null {
  const skill = discoverSkills(cwd).find(s => s.name === name) ?? discoverSkills(cwd).find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  if (skill.body) return { name: skill.name, body: skill.body }
  const { body } = parseFrontmatter(readFileSync(skill.path!, 'utf-8'))
  return { name: skill.name, body, dir: dirname(skill.path!) }
}

export function resetSkills() {
  cache.clear()
}
