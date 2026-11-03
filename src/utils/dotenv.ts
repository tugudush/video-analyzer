import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Minimal `.env` support.
 *
 * The CLI and MCP server both read configuration from the process environment,
 * and an agent-spawned Skill inherits that environment. A `.env` file in the
 * working directory is the convenient way to supply `GEMINI_API_KEY` without
 * editing shell profiles.
 *
 * Rules:
 * - Real environment variables always win; `.env` only fills gaps.
 * - A missing or unreadable file is not an error.
 * - Malformed lines are skipped rather than aborting startup.
 * - Values are used verbatim apart from quote stripping; escape sequences are
 *   not interpreted.
 */

const LINE_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Parse `.env` content into a plain record. */
export function parseDotEnv(source: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = line.match(LINE_PATTERN)
    if (!match) continue

    const [, key, rawValue] = match
    if (!key) continue

    let value = (rawValue ?? '').trim()

    if (value.startsWith('"') || value.startsWith("'")) {
      value = stripQuotes(value)
    } else {
      // Drop an unquoted trailing comment: `KEY=value # note`
      const comment = value.search(/\s#/)
      if (comment >= 0) value = value.slice(0, comment).trim()
    }

    result[key] = value
  }

  return result
}

/**
 * Load a `.env` file into `target`.
 *
 * @returns The names of the variables that were actually applied.
 */
export function loadDotEnvInto(target: NodeJS.ProcessEnv, filePath?: string): string[] {
  const resolved = filePath ?? path.join(process.cwd(), '.env')

  let source: string
  try {
    source = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }

  const applied: string[] = []
  for (const [key, value] of Object.entries(parseDotEnv(source))) {
    if (target[key] !== undefined && target[key] !== '') continue
    target[key] = value
    applied.push(key)
  }
  return applied
}
