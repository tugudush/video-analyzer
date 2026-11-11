#!/usr/bin/env node
/**
 * Skill launcher for video-analyzer.
 *
 * Locates the installed CLI, forwards a JSON payload without a shell, and
 * normalizes failures into a stable JSON envelope on stdout. The Skill calls
 * this script; it never starts or talks to the MCP server.
 *
 * Usage:
 *   node invoke.mjs <operation> ['{"json":"input"}']
 *   node invoke.mjs <operation> --json-file <path>
 *   node invoke.mjs list
 *   node invoke.mjs help [operation]
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fail(code, message, hint) {
  const payload = { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
  // Writing to a pipe is asynchronous on Windows, so the exit has to wait for
  // both streams or the envelope can be lost on the way out.
  return Promise.all([
    new Promise((resolve) =>
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`, resolve),
    ),
    new Promise((resolve) =>
      process.stderr.write(`${code}: ${message}${hint ? `\nHint: ${hint}` : ''}\n`, resolve),
    ),
  ]).then(() => process.exit(1))
}

/**
 * Resolve the CLI entry point.
 *
 * Preference order:
 *  1. VIDEO_ANALYZER_CLI_PATH (explicit override)
 *  2. a checkout-relative build (`<repo>/dist/cli.js`)
 *  3. the published bin on PATH (`video-analyzer`)
 *
 * `baseArgs` are the arguments that must precede the operation name: the script
 * path when we spawn `node` ourselves, nothing when we exec a PATH shim.
 */
async function resolveInvocation() {
  const override = process.env.VIDEO_ANALYZER_CLI_PATH
  if (override) {
    return { command: process.execPath, baseArgs: [path.resolve(override)] }
  }

  const repoRoot = path.resolve(HERE, '..', '..', '..')
  const localBuild = path.join(repoRoot, 'dist', 'cli.js')
  try {
    await readFile(localBuild, { encoding: 'utf8', flag: 'r' })
    return { command: process.execPath, baseArgs: [localBuild] }
  } catch {
    // Fall through to the globally installed binary.
  }

  return {
    command: process.platform === 'win32' ? 'video-analyzer.cmd' : 'video-analyzer',
    baseArgs: [],
  }
}

/** npm-installed bin shims are batch files and cannot be spawned directly on Windows. */
function isBatchShim(command) {
  return /\.(cmd|bat)$/i.test(command)
}

function run(command, argv) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

const [, , operation, ...rest] = process.argv

if (!operation) {
  await fail('INVALID_INPUT', 'No operation given.', 'Run: node invoke.mjs list')
}

/**
 * `help` and `list` take positional operands (`help extract_frames`), not a JSON
 * payload, so their arguments must not be folded into `--input`.
 */
const metaCommand = operation === 'help' || operation === 'list'

const forwarded = []
let payload
let payloadFile

for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index]
  if (arg === undefined) break
  if (arg === '--json-file') {
    payloadFile = rest[index + 1]
    index += 1
  } else if (arg.startsWith('--json-file=')) {
    payloadFile = arg.slice('--json-file='.length)
  } else if (arg === '--pretty') {
    forwarded.push('--pretty')
  } else if (!metaCommand && payload === undefined) {
    payload = arg
  } else {
    forwarded.push(arg)
  }
}

if (payloadFile) {
  try {
    payload = await readFile(path.resolve(payloadFile), 'utf8')
  } catch (error) {
    await fail('INPUT_NOT_FOUND', `Could not read ${payloadFile}.`, error.message)
  }
}

/**
 * Send the payload to the CLI.
 *
 * `cmd.exe` re-parses the whole `/c` string, so a `&`, `|`, or `^` inside a path
 * or question becomes a shell operator and the JSON arrives mangled. Batch shims
 * therefore receive the payload through a temporary file instead of an argument;
 * the direct `node` paths keep the argument form.
 */
const { command, baseArgs } = await resolveInvocation()
const viaComSpec = isBatchShim(command)
let payloadTempDir

async function cleanupPayload() {
  if (!payloadTempDir) return
  const staging = payloadTempDir
  payloadTempDir = undefined
  await rm(staging, { recursive: true, force: true }).catch((error) => {
    process.stderr.write(`Could not remove temporary directory ${staging}: ${error.message}\n`)
  })
}

if (payload !== undefined) {
  if (viaComSpec) {
    try {
      payloadTempDir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-owned-'))
      await writeFile(
        path.join(payloadTempDir, '.video-analyzer-owner.json'),
        JSON.stringify({ version: 1, pid: process.pid }),
        { flag: 'wx', mode: 0o600 },
      )
      const payloadTempFile = path.join(payloadTempDir, 'input.json')
      await writeFile(payloadTempFile, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      forwarded.push('--input-file', payloadTempFile)
    } catch (error) {
      await cleanupPayload()
      await fail('OUTPUT_FAILED', 'Could not stage the JSON payload for the CLI.', error.message)
    }
  } else {
    forwarded.push('--input', payload)
  }
}

const argv = [operation, ...forwarded]

try {
  const result = viaComSpec
    ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...argv])
    : await run(command, [...baseArgs, ...argv])

  if (!result.stdout.trim()) {
    await cleanupPayload()
    await fail(
      'INTERNAL',
      'The video-analyzer CLI produced no output.',
      result.stderr.trim() ||
        'Install the CLI (npm i -g video-analyzer), or set VIDEO_ANALYZER_CLI_PATH to dist/cli.js.',
    )
  }

  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
} finally {
  await cleanupPayload()
}
