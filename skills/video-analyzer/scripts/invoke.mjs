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
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fail(code, message, hint) {
  const payload = { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.stderr.write(`${code}: ${message}${hint ? `\nHint: ${hint}` : ''}\n`)
  process.exit(1)
}

/**
 * Resolve the CLI entry point.
 *
 * Preference order:
 *  1. VIDEO_ANALYZER_CLI_PATH (explicit override)
 *  2. the published bin on PATH (`video-analyzer`)
 *  3. a checkout-relative build (`<repo>/dist/cli.js`)
 */
async function resolveInvocation(args) {
  const override = process.env.VIDEO_ANALYZER_CLI_PATH
  if (override) {
    return { command: process.execPath, argv: [path.resolve(override), ...args] }
  }

  const repoRoot = path.resolve(HERE, '..', '..', '..')
  const localBuild = path.join(repoRoot, 'dist', 'cli.js')
  try {
    await readFile(localBuild, { encoding: 'utf8', flag: 'r' })
    return { command: process.execPath, argv: [localBuild, ...args] }
  } catch {
    // Fall through to the globally installed binary.
  }

  return {
    command: process.platform === 'win32' ? 'video-analyzer.cmd' : 'video-analyzer',
    argv: args,
  }
}

function run(command, argv) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
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
  fail('INVALID_INPUT', 'No operation given.', 'Run: node invoke.mjs list')
}

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
  } else if (payload === undefined) {
    payload = arg
  } else {
    forwarded.push(arg)
  }
}

if (payloadFile) {
  try {
    payload = await readFile(path.resolve(payloadFile), 'utf8')
  } catch (error) {
    fail('INPUT_NOT_FOUND', `Could not read ${payloadFile}.`, error.message)
  }
}

if (payload !== undefined) {
  forwarded.push('--input', payload)
}

const { command, argv } = await resolveInvocation([operation, ...forwarded])

if (command.endsWith('.cmd') || command.endsWith('.bat')) {
  // npm-installed shims are batch files and cannot be spawned directly on Windows.
  const result = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...argv])
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.code)
}

const result = await run(command, argv)

if (!result.stdout.trim()) {
  fail(
    'INTERNAL',
    'The video-analyzer CLI produced no output.',
    result.stderr.trim() ||
      'Install the CLI (npm i -g video-analyzer), or set VIDEO_ANALYZER_CLI_PATH to dist/cli.js.',
  )
}

process.stdout.write(result.stdout)
if (result.code !== 0) {
  process.stderr.write(result.stderr)
}
process.exit(result.code)
