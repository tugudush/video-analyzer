import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const SKILL_DIR = path.resolve('skills', 'video-analyzer')

interface Frontmatter {
  name?: string
  description?: string
  [key: string]: string | undefined
}

function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { data: {}, body: source }

  const data: Frontmatter = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!entry) continue
    const [, key, rawValue] = entry
    if (!key) continue
    let value = (rawValue ?? '').trim()
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: match[2] ?? '' }
}

describe('video-analyzer Skill package', () => {
  it('has a SKILL.md with matching name and a discoverable description', async () => {
    const source = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
    const { data } = parseFrontmatter(source)

    expect(data.name).toBe('video-analyzer')
    expect(data.description?.length ?? 0).toBeGreaterThan(80)
    expect(data.description?.length ?? 0).toBeLessThanOrEqual(1024)
  })

  it('mentions every operation so discovery can route to it', async () => {
    const source = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
    for (const operation of [
      'analyze_video',
      'summarize_video',
      'search_timestamp',
      'transcribe_video',
      'get_video_info',
      'extract_frames',
    ]) {
      expect(source).toContain(operation)
    }
  })

  it('stays within the progressive-loading budget', async () => {
    const source = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
    expect(source.split(/\r?\n/).length).toBeLessThan(500)
  })

  it('ships every referenced file', async () => {
    const source = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
    const references = [...source.matchAll(/\]\(\.\/(references\/[^)]+)\)/g)].map(
      (match) => match[1],
    )

    expect(references.length).toBeGreaterThan(0)
    for (const reference of references) {
      const info = await stat(path.join(SKILL_DIR, reference as string))
      expect(info.isFile()).toBe(true)
    }
  })

  it('ships the launcher script', async () => {
    const entries = await readdir(path.join(SKILL_DIR, 'scripts'))
    expect(entries).toContain('invoke.mjs')
  })

  it('launcher lists operations without an MCP server', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(SKILL_DIR, 'scripts', 'invoke.mjs'), 'list'],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, VIDEO_ANALYZER_LOG_LEVEL: 'silent' },
      },
    )

    const payload = JSON.parse(stdout) as { ok: boolean; operations: Array<{ name: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.operations).toHaveLength(6)
  })

  it('launcher reports missing input as a JSON error', async () => {
    let failure: { code?: number; stdout?: string } = {}
    try {
      await execFileAsync(process.execPath, [path.join(SKILL_DIR, 'scripts', 'invoke.mjs')], {
        timeout: 30_000,
        windowsHide: true,
      })
    } catch (error) {
      failure = error as { code?: number; stdout?: string }
    }

    expect(failure.code).toBe(1)
    const payload = JSON.parse(failure.stdout ?? '{}') as { ok: boolean; error: { code: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('INVALID_INPUT')
  })
})
