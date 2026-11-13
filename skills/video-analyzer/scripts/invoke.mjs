#!/usr/bin/env node
/**
 * Skill launcher for video-analyzer.
 *
 * Locates the installed CLI, forwards a JSON payload over stdin, and normalizes
 * failures into a stable JSON envelope on stdout. The Skill calls this script; it
 * never starts or talks to the MCP server.
 *
 * Usage:
 *   node invoke.mjs <operation> ['{"json":"input"}']
 *   node invoke.mjs <operation> --json-file <path>
 *   node invoke.mjs list
 *   node invoke.mjs help [operation]
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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
    const info = await stat(localBuild)
    if (!info.isFile()) throw new Error('The checkout build is not a file.')
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

/**
 * Whether an argument can pass through `cmd.exe` unchanged.
 *
 * A batch shim is spawned through the shell, which re-parses its `/c` line: `&`,
 * `|`, `<`, `>`, `^`, `%`, and parentheses are operators there. Node only quotes
 * an argument that contains whitespace, so such a value would divide the command
 * line. Only operation names and flags need to reach the shell — the payload
 * travels on stdin — so accepting just those avoids rebuilding cmd's quoting
 * rules, which differ again inside quotes.
 */
function isShellSafeArg(arg) {
  return /^[A-Za-z0-9_.:-]+$/.test(arg)
}

/**
 * Run the CLI with the payload on stdin.
 *
 * The JSON is never a command-line argument: Windows limits a command line to
 * roughly 32 KiB (far below the CLI's 1 MiB input limit), and staging it in a
 * temporary file still put that path on the `cmd.exe` line, where a `&` or `%`
 * in the temporary directory split or expanded it. Piped input carries the
 * payload verbatim, and it can be streamed straight from `--json-file`.
 */
function run(command, argv, input) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code, extra) => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr: `${stderr}${extra ?? ''}` })
    }

    let child
    try {
      child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      // A synchronous spawn failure (for example ENAMETOOLONG) would otherwise
      // escape as an uncaught exception and leave the caller without an envelope.
      finish(1, `${error.message}\n`)
      return
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    // The CLI stops reading as soon as it rejects a payload (for example as
    // oversized), so the resulting EPIPE is expected and must not escape.
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => finish(1, `${error.message}\n`))
    child.on('close', (code) => finish(code ?? 1))

    if (input?.kind === 'file') {
      const source = createReadStream(input.path)
      source.on('error', (error) => {
        child.kill()
        finish(1, `${error.message}\n`)
      })
      source.pipe(child.stdin)
      return
    }
    child.stdin.end(input?.kind === 'text' ? input.value : undefined)
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
  const resolved = path.resolve(payloadFile)
  try {
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error('Not a file.')
    // Resolved once here so the streamed payload and any later diagnostic name
    // the same target.
    payloadFile = resolved
  } catch (error) {
    await fail('INPUT_NOT_FOUND', `Could not read ${payloadFile}.`, error.message)
  }
}

/** What to send on stdin: the payload file untouched, the inline JSON, or nothing. */
const input = payloadFile
  ? { kind: 'file', path: payloadFile }
  : payload !== undefined
    ? { kind: 'text', value: payload }
    : undefined

const argv = [operation, ...forwarded]
const { command, baseArgs } = await resolveInvocation()
const viaComSpec = isBatchShim(command)

if (viaComSpec && !argv.every(isShellSafeArg)) {
  await fail(
    'INVALID_INPUT',
    'A Windows batch shim cannot carry these arguments safely.',
    'Pass only the operation name and its flags; put request data in the JSON payload.',
  )
}

const result = viaComSpec
  ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...argv], input)
  : await run(command, [...baseArgs, ...argv], input)

if (!result.stdout.trim()) {
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
