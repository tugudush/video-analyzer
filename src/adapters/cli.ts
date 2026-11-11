import { readFile } from 'node:fs/promises'
import { loadConfig, type Config } from '../config.js'
import { listOperations, requireOperation } from '../operations/registry.js'
import { executeOperation } from '../operations/execute.js'
import { toResultEnvelope } from './envelope.js'
import { createLogger } from '../utils/logger.js'
import { toErrorEnvelope, toVideoAnalyzerError, invalidInput } from '../utils/errors.js'
import type { ErrorEnvelope } from '../utils/errors.js'
import { zodErrorToInvalidInput } from './mcpTools.js'
import { z, ZodError } from 'zod'

export interface CliIO {
  stdout(text: string): void
  stderr(text: string): void
  /**
   * Optional stdin reader. Provided by the real CLI entry point and omitted in
   * tests so an interactive or empty stdin can never block execution.
   */
  readStdin?(): Promise<string | undefined>
}

export const defaultCliIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    if (process.stdin.isTTY) return undefined
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text.trim() === '' ? undefined : text
  },
}

export const CLI_USAGE = `video-analyzer — Gemini-powered video and audio analysis

Usage:
  video-analyzer list
  video-analyzer <operation> --input '<json>' [--input-file <path>] [--pretty]
  video-analyzer <operation> < <json-file>          (JSON on stdin)
  video-analyzer mcp                                (run the MCP server over stdio)
  video-analyzer help [operation]

Operations:
${listOperations()
  .map((operation) => `  ${operation.name.padEnd(20)} ${operation.description.split('.')[0]}.`)
  .join('\n')}

Input:
  Pass operation arguments as a single JSON object. Use --input-file or stdin when
  the arguments are long or contain Windows path backslashes.

Output:
  A single JSON envelope on stdout. Diagnostics go to stderr only.

Environment:
  GEMINI_API_KEY                     Required for Gemini-backed operations
  GEMINI_MODEL                       Override the default Gemini model
  VIDEO_ANALYZER_MAX_FRAMES          AI frame ceiling (0 = uncapped, default 100)
  VIDEO_ANALYZER_DOWNLOAD_MAX_MB     Remote download size limit
  VIDEO_ANALYZER_REQUEST_TIMEOUT_MS  AI request timeout
  VIDEO_ANALYZER_OUTPUT_DIR          Base directory for generated artifacts
  VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS Allow private/loopback direct media hosts
  VIDEO_ANALYZER_LOG_LEVEL           silent|error|warn|info|debug
  FFMPEG_PATH / FFPROBE_PATH
`

interface ParsedArgs {
  command: string
  input?: string
  inputFile?: string
  pretty: boolean
  help: boolean
  rest: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const parsed: ParsedArgs = { command, pretty: false, help: false, rest: [] }

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === undefined) break

    if (arg === '--pretty') {
      parsed.pretty = true
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--input' || arg === '-i') {
      const value = rest[++index]
      if (value === undefined) throw invalidInput('--input requires a JSON value.')
      parsed.input = value
    } else if (arg.startsWith('--input=')) {
      parsed.input = arg.slice('--input='.length)
    } else if (arg === '--input-file') {
      const value = rest[++index]
      if (value === undefined) throw invalidInput('--input-file requires a path.')
      parsed.inputFile = value
    } else if (arg.startsWith('--input-file=')) {
      parsed.inputFile = arg.slice('--input-file='.length)
    } else if (arg !== undefined) {
      parsed.rest.push(arg)
    }
  }

  return parsed
}

async function resolveInputJson(parsed: ParsedArgs, io: CliIO): Promise<unknown> {
  let raw: string | undefined

  if (parsed.inputFile) {
    raw = await readFile(parsed.inputFile, 'utf8')
  } else if (parsed.input !== undefined) {
    raw = parsed.input
  } else if (io.readStdin) {
    raw = await io.readStdin()
  }

  if (raw === undefined || raw.trim() === '') {
    throw invalidInput(`${parsed.command} requires arguments.`, {
      hint: `Pass --input '{"..."}' , --input-file <path>, or JSON on stdin. Run "video-analyzer help ${parsed.command}" for the schema.`,
    })
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw invalidInput('Arguments must be valid JSON.', {
      hint: 'On Windows shells, prefer --input-file or stdin to avoid backslash escaping issues.',
      cause: error,
    })
  }
}

function writeError(io: CliIO, envelope: ErrorEnvelope, pretty: boolean): number {
  const payload = { ok: false as const, error: envelope }
  io.stdout(JSON.stringify(payload, null, pretty ? 2 : undefined) + '\n')
  io.stderr(
    `${envelope.code}: ${envelope.message}${envelope.hint ? `\nHint: ${envelope.hint}` : ''}\n`,
  )
  return 1
}

function describeSchema(inputSchema: unknown): string {
  try {
    return JSON.stringify(z.toJSONSchema(inputSchema as z.ZodType), null, 2)
  } catch {
    return 'Schema description unavailable; see the README for argument names.'
  }
}

/**
 * CLI entry point.
 *
 * Returns a process exit code. The Skill launcher and direct users both call
 * this, and neither path touches the MCP server.
 */
export async function runCli(
  argv: string[],
  io: CliIO = defaultCliIO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let config: Config
  try {
    config = loadConfig(env)
  } catch (error) {
    return writeError(io, toErrorEnvelope(error), false)
  }

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return writeError(io, toErrorEnvelope(error), false)
  }

  if (parsed.command === 'help' || parsed.help) {
    const target = parsed.command === 'help' ? parsed.rest[0] : parsed.command
    if (target && target !== 'mcp' && target !== 'list') {
      const operation = listOperations().find((entry) => entry.name === target)
      if (operation) {
        io.stdout(
          `${operation.name} — ${operation.title}\n\n${operation.description}\n\nInput schema:\n${describeSchema(operation.inputSchema)}\n`,
        )
        return 0
      }
    }
    io.stdout(CLI_USAGE)
    return 0
  }

  if (parsed.command === 'list') {
    io.stdout(
      JSON.stringify(
        {
          ok: true,
          operations: listOperations().map((operation) => ({
            name: operation.name,
            title: operation.title,
            description: operation.description,
            category: operation.category,
            requiresGemini: operation.requiresGemini,
          })),
        },
        null,
        parsed.pretty ? 2 : undefined,
      ) + '\n',
    )
    return 0
  }

  if (parsed.command === 'mcp') {
    const { runMcpServer } = await import('./mcpServer.js')
    await runMcpServer(config)
    return 0
  }

  try {
    const operation = requireOperation(parsed.command)
    const rawInput = await resolveInputJson(parsed, io)

    let input: unknown
    try {
      input = operation.inputSchema.parse(rawInput)
    } catch (error) {
      if (error instanceof ZodError) throw zodErrorToInvalidInput(error)
      throw error
    }

    const logger = createLogger(config.logLevel)
    const result = await executeOperation(operation, input, config, {
      logger,
      onProgress: (message) => {
        if (config.logLevel === 'debug' || config.logLevel === 'info') {
          io.stderr(`… ${message}\n`)
        }
      },
    })

    const envelope = { operation: operation.name, ...toResultEnvelope(result) }
    io.stdout(JSON.stringify(envelope, null, parsed.pretty ? 2 : undefined) + '\n')

    for (const warning of envelope.warnings) {
      io.stderr(`Warning: ${warning}\n`)
    }

    return 0
  } catch (error) {
    const normalized = toVideoAnalyzerError(error)
    return writeError(io, normalized.toEnvelope(), parsed.pretty)
  }
}
