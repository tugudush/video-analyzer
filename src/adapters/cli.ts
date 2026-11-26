import { readFile, stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { loadConfig, type Config } from '../config.js'
import { listOperations, requireOperation } from '../operations/registry.js'
import { executeOperation } from '../operations/execute.js'
import { toResultEnvelope } from './envelope.js'
import { createLogger, type Logger } from '../utils/logger.js'
import {
  toErrorEnvelope,
  toVideoAnalyzerError,
  VideoAnalyzerError,
  inputNotFound,
  invalidInput,
} from '../utils/errors.js'
import type { ErrorEnvelope } from '../utils/errors.js'
import { sweepStaleTempDirs } from '../utils/fsUtils.js'
import { VERSION } from '../version.js'
import { z } from 'zod'

export interface CliIO {
  stdout(text: string): void
  stderr(text: string): void
  /**
   * Optional stdin reader. Provided by the real CLI entry point and omitted in
   * tests so an interactive or empty stdin can never block execution.
   */
  readStdin?(): Promise<string | undefined>
  /**
   * Optional cancellation source. The real CLI aborts the running operation on
   * Ctrl-C; tests omit it so a stray signal in the runner can never fire mid-case.
   * Returns a disposer that removes the listener again.
   */
  onCancel?(handler: () => void): () => void
}

/** Largest JSON payload accepted from stdin, `--input`, or `--input-file`. */
export const MAX_INPUT_BYTES = 1024 * 1024

function inputTooLarge(source: string): Error {
  return invalidInput(`The input payload exceeds the ${MAX_INPUT_BYTES}-byte limit.`, {
    hint: 'Pass a smaller JSON payload; operation arguments are small by design.',
    details: { source, maxBytes: MAX_INPUT_BYTES },
  })
}

/** Read a piped text payload through EOF; silence is not an end-of-input marker. */
export async function readStdinToEnd(
  stream: Readable,
  maxBytes = MAX_INPUT_BYTES,
): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > maxBytes) throw inputTooLarge('stdin')
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof VideoAnalyzerError) throw error
    throw inputNotFound('Could not read standard input.', { cause: error })
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? undefined : text
}

export const defaultCliIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onCancel: (handler) => {
    process.once('SIGINT', handler)
    return () => process.removeListener('SIGINT', handler)
  },
  readStdin: async () => {
    if (process.stdin.isTTY) return undefined
    return readStdinToEnd(process.stdin)
  },
}

export const CLI_USAGE = `video-analyzer — Gemini-powered video and audio analysis

Usage:
  video-analyzer --version
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
  Operations and "list" print a single JSON envelope on stdout. "--version" and
  "help" print plain text. Diagnostics go to stderr only.

Environment:
  GEMINI_API_KEY                     Required for Gemini-backed operations
  GEMINI_MODEL                       Override the default Gemini model
  VIDEO_ANALYZER_MAX_FRAMES          Frame budget for interval and scene extraction
                                     (default 100, 0 = only the 500-frame hard cap)
  VIDEO_ANALYZER_DOWNLOAD_MAX_MB     Remote download size limit
  VIDEO_ANALYZER_REQUEST_TIMEOUT_MS  Deadline for each Gemini call
  VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS   Budget for upload + processing until ACTIVE
  VIDEO_ANALYZER_POLL_INTERVAL_MS    Upload status poll interval
  VIDEO_ANALYZER_OUTPUT_DIR          Base directory for generated artifacts
  VIDEO_ANALYZER_CACHE_DIR           Directory for persistent Gemini upload cache (env only)
  VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS Allow private/loopback direct media hosts
  VIDEO_ANALYZER_LOG_LEVEL           silent|error|warn|info|debug
  FFMPEG_PATH / FFPROBE_PATH
  YT_DLP_PATH                        yt-dlp executable (platform page URLs)
  YT_DLP_MAX_RESOLUTION              Highest downloaded video height (default 720)
  YT_DLP_COOKIES_FILE                Netscape cookies file for authenticated media
  YT_DLP_IMPERSONATE                 Browser client passed to yt-dlp --impersonate

  A .env file in the working directory may only set GEMINI_API_KEY, GEMINI_MODEL,
  VIDEO_ANALYZER_MAX_FRAMES, VIDEO_ANALYZER_DOWNLOAD_MAX_MB, the three timeout
  settings, VIDEO_ANALYZER_OUTPUT_DIR, and VIDEO_ANALYZER_LOG_LEVEL. It cannot set
  PATH, FFMPEG_PATH/FFPROBE_PATH, VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS,
  VIDEO_ANALYZER_CACHE_DIR, or VIDEO_ANALYZER_CLI_PATH. The YT_DLP_* settings are
  read from the environment only.
`

interface ParsedArgs {
  command: string
  input?: string
  inputFile?: string
  pretty: boolean
  help: boolean
  version: boolean
  rest: string[]
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand = 'help', ...rest] = argv
  const leadingVersionFlag = rawCommand === '--version' || rawCommand === '-v'
  const parsed: ParsedArgs = {
    command: leadingVersionFlag ? 'help' : rawCommand,
    pretty: false,
    help: false,
    version: leadingVersionFlag,
    rest: [],
  }

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === undefined) break

    if (arg === '--pretty') {
      parsed.pretty = true
    } else if (arg === '--version' || arg === '-v') {
      parsed.version = true
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
    } else if (arg.startsWith('-')) {
      throw invalidInput(`Unknown option: ${arg}`, {
        hint: 'Supported options: --input, --input-file, --pretty, --version, --help.',
      })
    } else {
      parsed.rest.push(arg)
    }
  }

  return parsed
}

function inputFileReadError(filePath: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  const hint =
    'Check the path, or pass the arguments with --input or on stdin. Run "video-analyzer help <operation>" for the schema.'
  if (code === 'ENOENT') {
    return inputNotFound(`Input file not found: ${filePath}`, { hint, cause: error })
  }
  return inputNotFound(`Could not read the input file: ${filePath}`, {
    hint,
    ...(code ? { details: { code } } : {}),
    cause: error,
  })
}

/** Read the payload file, refusing an oversized one before loading it. */
async function readInputFile(filePath: string): Promise<string> {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    throw inputFileReadError(filePath, error)
  }
  if (info.size > MAX_INPUT_BYTES) throw inputTooLarge(filePath)
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw inputFileReadError(filePath, error)
  }
}

async function resolveInputJson(parsed: ParsedArgs, io: CliIO): Promise<unknown> {
  if (parsed.input !== undefined && parsed.inputFile !== undefined) {
    throw invalidInput('Pass either --input or --input-file, not both.')
  }

  let raw: string | undefined
  let source = 'stdin'

  if (parsed.inputFile) {
    source = parsed.inputFile
    raw = await readInputFile(parsed.inputFile)
  } else if (parsed.input !== undefined) {
    source = '--input'
    raw = parsed.input
  } else if (io.readStdin) {
    raw = await io.readStdin()
  }

  if (raw === undefined || raw.trim() === '') {
    throw invalidInput(`${parsed.command} requires arguments.`, {
      hint: `Pass --input '{"..."}' , --input-file <path>, or JSON on stdin. Run "video-analyzer help ${parsed.command}" for the schema.`,
    })
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) throw inputTooLarge(source)

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

let tempSweepStarted = false

/**
 * Clean up temp directories left by a killed process.
 *
 * The MCP server does this at startup; the CLI is usually short-lived, so it
 * sweeps once per process on the first operation instead.
 */
function sweepTempDirsOnce(logger: Logger): void {
  if (tempSweepStarted) return
  tempSweepStarted = true
  void sweepStaleTempDirs({ logger }).catch((error: unknown) =>
    logger.warn(`Could not scan temporary directories: ${String(error)}`),
  )
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
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return writeError(io, toErrorEnvelope(error), false)
  }

  // Version, help, and list are diagnostics, not work: they must keep answering
  // when configuration is malformed, because "help <operation>" is the
  // documented recovery step for a rejected request. Configuration is loaded
  // below, and only for the branches that consume it.
  if (parsed.version) {
    io.stdout(`${VERSION}\n`)
    return 0
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

  let config: Config
  try {
    config = loadConfig(env)
  } catch (error) {
    return writeError(io, toErrorEnvelope(error), false)
  }

  if (parsed.command === 'mcp') {
    const { runMcpServer } = await import('./mcpServer.js')
    await runMcpServer(config)
    return 0
  }

  try {
    const operation = requireOperation(parsed.command)
    if (parsed.rest.length > 0) {
      throw invalidInput(`Unexpected positional argument(s): ${parsed.rest.join(' ')}`, {
        hint: 'Pass operation arguments as JSON via --input, --input-file, or stdin.',
      })
    }
    // `executeOperation` validates against the operation's own schema, so the
    // adapter does not parse the same payload a second time.
    const input = await resolveInputJson(parsed, io)

    const logger = createLogger(config.logLevel)
    sweepTempDirsOnce(logger)
    // Ctrl-C aborts the in-flight request instead of killing the process, so the
    // operation reports GEMINI_TIMEOUT and the envelope still reaches the caller.
    const controller = new AbortController()
    const disposeCancel = io.onCancel?.(() => controller.abort())
    const result = await executeOperation(operation, input, config, {
      logger,
      signal: controller.signal,
      onProgress: (message) => {
        if (config.logLevel === 'debug' || config.logLevel === 'info') {
          io.stderr(`… ${message}\n`)
        }
      },
    }).finally(() => disposeCancel?.())

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
