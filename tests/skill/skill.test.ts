import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const SKILL_DIR = path.resolve('skills', 'video-analyzer')

/**
 * These tests drive the packaged launcher, which runs the compiled CLI. `npm test`
 * builds first; a direct `npx vitest` run on a clean checkout would otherwise
 * fail with an obscure "produced no output" error.
 */
beforeAll(async () => {
  try {
    await stat(path.resolve(SKILL_DIR, '..', '..', 'dist', 'cli.js'))
  } catch {
    throw new Error(
      'The Skill suite runs the packaged launcher, so dist/ must be built. Run `npm run build` (npm test does this automatically).',
    )
  }
})

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

/**
 * A launcher copy that resolves to a batch shim on `PATH`, the way a global
 * install does. Only `cmd.exe` can run the shim, so these cases are Windows-only.
 */
async function createShimHarness(prefix: string): Promise<{
  root: string
  launcher: string
  env: NodeJS.ProcessEnv
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const scripts = path.join(root, 'skills', 'video-analyzer', 'scripts')
  const bin = path.join(root, 'bin')
  await mkdir(scripts, { recursive: true })
  await mkdir(bin, { recursive: true })
  await copyFile(path.join(SKILL_DIR, 'scripts', 'invoke.mjs'), path.join(scripts, 'invoke.mjs'))

  // Stand-in for the installed shim: a batch file forwarding to this build.
  const cli = path.resolve(SKILL_DIR, '..', '..', 'dist', 'cli.js')
  await writeFile(
    path.join(bin, 'video-analyzer.cmd'),
    `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`,
  )

  const pathValue = `${bin}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ''}`
  const env: NodeJS.ProcessEnv = { ...process.env, Path: pathValue, PATH: pathValue }
  delete env.VIDEO_ANALYZER_CLI_PATH
  return { root, launcher: path.join(scripts, 'invoke.mjs'), env }
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

  /**
   * `help <operation>` is the documented way to discover an operation's schema,
   * so its operand must reach the CLI as an operand rather than as a JSON payload.
   */
  it('launcher passes the help operand through to the CLI', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(SKILL_DIR, 'scripts', 'invoke.mjs'), 'help', 'extract_frames'],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, VIDEO_ANALYZER_LOG_LEVEL: 'silent' },
      },
    )

    expect(stdout).toContain('extract_frames')
    expect(stdout).toContain('Input schema')
    expect(stdout).not.toContain('Usage:')
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

  it('preserves UTF-8 characters split across stdout and stderr chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-analyzer-utf8-'))
    const cli = path.join(root, 'fake-cli.mjs')
    try {
      await writeFile(
        cli,
        [
          'process.stdout.write(Buffer.from(\'{"ok":false,"message":"Caf\'))',
          "process.stderr.write(Buffer.from('Caf'))",
          'process.stdout.write(Buffer.from([0xc3]))',
          'process.stderr.write(Buffer.from([0xc3]))',
          'setTimeout(() => {',
          '  process.stdout.write(Buffer.from([0xa9, 0x22, 0x7d, 0x0a]))',
          '  process.stderr.write(Buffer.from([0xa9, 0x0a]))',
          '  process.exitCode = 1',
          '}, 100)',
        ].join('\n'),
      )
      let failure: { stdout?: string; stderr?: string } = {}
      try {
        await execFileAsync(
          process.execPath,
          [path.join(SKILL_DIR, 'scripts', 'invoke.mjs'), 'list'],
          {
            timeout: 30_000,
            windowsHide: true,
            env: { ...process.env, VIDEO_ANALYZER_CLI_PATH: cli },
          },
        )
      } catch (error) {
        failure = error as { stdout?: string; stderr?: string }
      }
      expect(JSON.parse(failure.stdout ?? '{}')).toEqual({ ok: false, message: 'Café' })
      expect(failure.stderr).toBe('Café\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('forwards diagnostics from a successful CLI run without changing stdout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-analyzer-diagnostics-'))
    const cli = path.join(root, 'fake-cli.mjs')
    try {
      await writeFile(
        cli,
        `process.stdout.write('{"ok":true}\\n'); process.stderr.write('Warning: cleanup failed\\n')`,
      )
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [path.join(SKILL_DIR, 'scripts', 'invoke.mjs'), 'list'],
        {
          timeout: 30_000,
          windowsHide: true,
          env: { ...process.env, VIDEO_ANALYZER_CLI_PATH: cli },
        },
      )
      expect(JSON.parse(stdout)).toEqual({ ok: true })
      expect(stderr).toBe('Warning: cleanup failed\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The user-level install resolves to the npm bin shim, a batch file that has
   * to run through `cmd.exe`. `cmd.exe` re-parses the whole `/c` string, so an
   * argument loses `&`, `|`, and `^` to the shell; the launcher must therefore
   * carry the payload on stdin instead.
   */
  it.skipIf(process.platform !== 'win32')(
    'launcher keeps payload metacharacters intact through the Windows cmd shim',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'video-analyzer-skill-'))
      const scripts = path.join(root, 'skills', 'video-analyzer', 'scripts')
      const bin = path.join(root, 'bin')

      try {
        await mkdir(scripts, { recursive: true })
        await mkdir(bin, { recursive: true })
        await copyFile(
          path.join(SKILL_DIR, 'scripts', 'invoke.mjs'),
          path.join(scripts, 'invoke.mjs'),
        )

        // Stand-in for the installed shim: a batch file forwarding to this build.
        const cli = path.resolve(SKILL_DIR, '..', '..', 'dist', 'cli.js')
        await writeFile(
          path.join(bin, 'video-analyzer.cmd'),
          `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`,
        )

        const pathValue = `${bin}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ''}`
        const env: NodeJS.ProcessEnv = { ...process.env, Path: pathValue, PATH: pathValue }
        delete env.VIDEO_ANALYZER_CLI_PATH

        let failure: { code?: number; stdout?: string } = {}
        try {
          await execFileAsync(
            process.execPath,
            [
              path.join(scripts, 'invoke.mjs'),
              'get_video_info',
              JSON.stringify({ videoPath: path.join(root, 'a&b|c^d.mp4') }),
            ],
            { timeout: 30_000, windowsHide: true, env },
          )
        } catch (error) {
          failure = error as { code?: number; stdout?: string }
        }

        // Reaching the filesystem check proves the JSON survived the shell: a
        // mangled payload fails earlier as INVALID_INPUT.
        expect(failure.code).toBe(1)
        const payload = JSON.parse(failure.stdout ?? '{}') as { error?: { code?: string } }
        expect(payload.error?.code).toBe('INPUT_NOT_FOUND')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('streams a payload larger than a Windows command line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-analyzer-large-'))
    try {
      const argsFile = path.join(root, 'args.json')
      // Far past the ~32 KiB Windows command-line limit and below the CLI's
      // 1 MiB input cap, which is exactly what `--json-file` exists for.
      await writeFile(argsFile, JSON.stringify({ videoPath: 'x'.repeat(100_000) }))

      let failure: { code?: number; stdout?: string; stderr?: string } = {}
      try {
        await execFileAsync(
          process.execPath,
          [
            path.join(SKILL_DIR, 'scripts', 'invoke.mjs'),
            'get_video_info',
            '--json-file',
            argsFile,
          ],
          { timeout: 30_000, windowsHide: true },
        )
      } catch (error) {
        failure = error as { code?: number; stdout?: string; stderr?: string }
      }

      // An oversized command line yields no envelope at all, so the CLI's own
      // filesystem error proves the whole payload arrived.
      expect(failure.code).toBe(1)
      expect(failure.stderr ?? '').not.toContain('ENAMETOOLONG')
      const payload = JSON.parse(failure.stdout ?? '{}') as { error?: { code?: string } }
      expect(payload.error?.code).toBe('INPUT_NOT_FOUND')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'streams a --json-file payload whose path has shell metacharacters',
    async () => {
      const harness = await createShimHarness('video-analyzer-meta-')
      try {
        // `&` and a space split a `cmd.exe` command line, and the payload path
        // used to travel through one.
        const payloadDir = path.join(harness.root, 'a & b')
        await mkdir(payloadDir, { recursive: true })
        const argsFile = path.join(payloadDir, 'args.json')
        await writeFile(
          argsFile,
          JSON.stringify({ videoPath: path.join(harness.root, 'missing.mp4') }),
        )

        let failure: { code?: number; stdout?: string } = {}
        try {
          await execFileAsync(
            process.execPath,
            [harness.launcher, 'get_video_info', '--json-file', argsFile],
            { timeout: 30_000, windowsHide: true, env: harness.env },
          )
        } catch (error) {
          failure = error as { code?: number; stdout?: string }
        }

        expect(failure.code).toBe(1)
        const payload = JSON.parse(failure.stdout ?? '{}') as { error?: { code?: string } }
        expect(payload.error?.code).toBe('INPUT_NOT_FOUND')
      } finally {
        await rm(harness.root, { recursive: true, force: true })
      }
    },
  )
})
