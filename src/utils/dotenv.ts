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
 * - A trailing `# comment` is dropped, whether it follows a bare value or a
 *   quoted one (`KEY="value" # note`).
 * - The file is untrusted input (it travels with a repository), so callers may
 *   restrict which keys it may contribute; see `allowKeys`.
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
      // A quoted value closes at the matching quote; anything after it may only
      // be whitespace or a comment. Scanning for the closing quote (instead of
      // testing the last character) keeps `KEY="value" # note` intact, which is
      // a common way to annotate a secret.
      const quote = value[0] as string
      const closing = value.indexOf(quote, 1)
      value =
        closing > 0 && /^(?:\s+#.*)?$/.test(value.slice(closing + 1))
          ? value.slice(1, closing)
          : stripQuotes(value)
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
 * `allowKeys` restricts which variables the file may contribute. It is used for
 * `.env` files found in the working directory, which are untrusted input, so a
 * file that cannot choose the media binaries or relax the network policy.
 *
 * @returns The names of the variables that were actually applied.
 */
export function loadDotEnvInto(
  target: NodeJS.ProcessEnv,
  filePath?: string,
  options: { allowKeys?: readonly string[] } = {},
): string[] {
  const resolved = filePath ?? path.join(process.cwd(), '.env')

  let source: string
  try {
    source = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }

  const allowed = options.allowKeys ? new Set(options.allowKeys) : undefined
  const applied: string[] = []
  for (const [key, value] of Object.entries(parseDotEnv(source))) {
    if (allowed && !allowed.has(key)) continue
    if (target[key] !== undefined && target[key] !== '') continue
    target[key] = value
    applied.push(key)
  }
  return applied
}
