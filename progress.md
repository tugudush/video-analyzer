# Implementation Progress

Tracks work against [`findings-and-plan.md`](./findings-and-plan.md). Updated as each phase lands.

**Status:** In progress
**Last updated:** 2026-10-30

---

## Phase 1 — Foundation and interface contracts

### Done

- [x] Project scaffold: `package.json` (ESM, Node >= 22, `video-analyzer` + `video-analyzer-mcp` bins), `tsconfig.json` (typecheck), `tsconfig.build.json` (emit to `dist/`), `.gitignore`, Prettier config.
- [x] Dependencies installed: `@google/genai`, `@modelcontextprotocol/sdk`, `zod`; dev: `typescript` 7, `vitest` 5, `@types/node`, `prettier`.
- [x] `src/utils/errors.ts` — `VideoAnalyzerError` with a stable `ErrorCode` union and JSON envelope.
- [x] `src/utils/logger.ts` — stderr/MCP-sink diagnostics; stdout reserved for protocol/CLI output.
- [x] `src/utils/fsUtils.ts` — temp dir create/remove plus stale-directory sweep.
- [x] `src/utils/mime.ts` — extension → MIME mapping for video/audio/images.
- [x] `src/utils/base64.ts`.
- [x] `src/config.ts` — environment parsing with validation, `DEFAULT_GEMINI_MODEL`, `requireGeminiApiKey()`.
- [x] `src/utils/net.ts` — SSRF-guarded HTTP(S) validation (IPv4/IPv6 reserved ranges, blocked hostnames, per-redirect revalidation) and a size/timeout-bounded streaming downloader.
- [x] `tsc --noEmit` passes.

### Notes / deviations

- **Linting uses oxlint, not ESLint.** See the dedicated section below for why.
- **SSRF checks are best-effort.** DNS is resolved and every redirect hop revalidated, but the resolve→connect window is not pinned, so a rebinding race is theoretically possible. Documented rather than silently ignored.
- **Gemini model default is `gemini-3.8-flash`** (overridable via `GEMINI_MODEL`). Verify at implementation sign-off against Google's current model list; a retired default surfaces a clear API error rather than silently switching models.

---

## Phase 2 — Media input and local tools

### Done

- [x] `src/services/mediaInput.ts` — local path / `file://` URI / direct HTTP(S) / platform URL resolution. Direct downloads fall back to yt-dlp when the server returns a non-media content type. yt-dlp runs with argument arrays only, plus cookies/impersonation/resolution options and a 15-minute timeout.
- [x] `src/services/ffmpeg.ts` — ffprobe metadata (duration, container, bitrate, video/audio stream details), frame extraction by count, interval, explicit timestamps, and scene detection (parses `showinfo` `pts_time`), redaction rendering for blur / pixelate / blackout, and preview-frame rendering with outlined regions.
- [x] `get_video_info` operation — no AI, formatted summary plus structured metadata.
- [x] `extract_frames` operation — four modes, `maxImages`/`offset` pagination, configurable `outputDir`, scene budget from `VIDEO_ANALYZER_MAX_FRAMES`.
- [x] `redact_sensitive` operation — manual regions validated/clamped against real frame dimensions; AI detection gated behind `allowRemoteAnalysis`; preview and full render paths; refuses to overwrite the source.
- [x] Verified end-to-end on a generated 6s H.264/AAC fixture: metadata, frame extraction, and blur redaction all produce correct output (blur visually confirmed by comparing source vs rendered frames).

### Notes / deviations

- **ffmpeg was not on PATH on this machine.** Installed `Gyan.FFmpeg 9.0.2` via winget for verification. The winget `Links` shim needed a shell restart, so the bin directory was added to `PATH` manually for testing. `FFMPEG_PATH` / `FFPROBE_PATH` remain the documented override.
- **`extract_frames` writes files even for MCP.** Frames are persisted (auto-created folder under the output directory) instead of being base64-only, so both interfaces return the same durable artifacts. The MCP adapter inlines base64 in addition to reporting paths.
- **Scene detection is capped at 200 frames** regardless of the removed Pro ceiling, as a memory/time safety bound. This is a resource guard, not a licence gate.
- **Bug found and fixed during verification:** explicit `outputDir`/`outputPath` directories were not created before invoking ffmpeg. Both operations now `ensureDir` their targets.

---

## Phase 3 — Shared Gemini service

### Done

- [x] `src/services/gemini.ts` — `GeminiApi` interface with an SDK-backed implementation (`files.upload`, `files.get`, `models.generateContent`) so the pipeline is testable without credentials.
- [x] One shared `GeminiMediaService` handling: cache lookup → `ACTIVE` re-check → in-flight coalescing → upload → bounded polling → cache registration.
- [x] Bounded `ACTIVE` polling driven by `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS` / `VIDEO_ANALYZER_POLL_INTERVAL_MS`, with explicit `GEMINI_TIMEOUT`, `GEMINI_PROCESSING_FAILED`, and `GEMINI_UPLOAD_FAILED` errors.
- [x] In-memory LRU (32 entries) keyed by absolute path + size + mtime, honouring `expirationTime` when Gemini reports it.
- [x] Process-wide singleton so a long-lived MCP session reuses uploads across tool calls; injectable for tests via `OperationContext.geminiService`.

### Notes / deviations

- The SDK also exposes `files.delete`. Automatic deletion after use is deliberately **not** implemented: the cache is meant to reuse the upload, and Gemini expires files itself (~48h). Revisit if quota pressure appears.

---

## Phase 4/5/6 — Analysis, transcription, redaction operations

### Done

- [x] `analyze_video` — native video+audio prompt with an anti-hallucination system instruction.
- [x] `summarize_video` — five-section structured summary, optional `focus`.
- [x] `search_timestamp` — strict `MATCH <start> <end> — description` contract with a lenient parser, explicit `NO_MATCH` handling, and a standing warning that timestamps are model estimates.
- [x] `transcribe_video` — plain-text transcript, optional `language` / `translateToEnglish`, optional `outputPath`; `.srt`/`.vtt` targets are rejected with an explanation instead of fabricating cue timings.
- [x] No provider enums, fallback chains, audio routers, or licensing remain anywhere in `src/`.

---

## Phase 1 (cont.) — Registry and adapters

### Done

- [x] `src/operations/registry.ts` — the seven operations are the single source of truth for names, titles, descriptions, schemas, and handlers.
- [x] `src/operations/execute.ts` — one execution path used by both adapters.
- [x] `src/adapters/envelope.ts` — shared result envelope; base64 inlining only for interfaces that need it.
- [x] `src/adapters/mcpTools.ts` + `mcpServer.ts` — MCP stdio server, per-tool error containment, image content blocks, progress via MCP logging notifications, stdout kept clean for protocol frames.
- [x] `src/adapters/cli.ts` + `src/cli.ts` — JSON-in / JSON-out CLI with `list`, `help`, `mcp`, `--input`, `--input-file`, stdin, `--pretty`; errors go to stdout as an envelope **and** stderr as text with a nonzero exit code.
- [x] `src/mcp.ts` — dedicated MCP binary.
- [x] `npm run build` succeeds; `node dist/cli.js list|help|get_video_info|extract_frames|redact_sensitive` verified against real media.

---

## Phase 7 — Agent Skill

### Done

- [x] `skills/video-analyzer/SKILL.md` — frontmatter (`name: video-analyzer`, keyword-rich description covering every operation), operation-selection table, step-by-step procedure, result-presentation rules, and an error-code table. Under the 500-line progressive-loading budget.
- [x] `references/operations.md` — full argument tables, examples, and output shape per operation.
- [x] `references/configuration.md` — every environment variable with defaults.
- [x] `references/troubleshooting.md` — per-error-code recovery guidance.
- [x] `scripts/invoke.mjs` — launcher that resolves the CLI (`VIDEO_ANALYZER_CLI_PATH` → local `dist/cli.js` → global binary), spawns without a shell, forwards JSON, normalizes missing-output failures into a JSON envelope, and handles Windows `.cmd` shims through `cmd.exe`.
- [x] Verified: `node skills/video-analyzer/scripts/invoke.mjs get_video_info …` returns the same envelope as the CLI, with no MCP server involved.
- [x] Skill tests cover frontmatter validity, name/folder match, operation discoverability, line budget, referenced-file existence, launcher listing, and launcher error handling.

### Notes / deviations

- The launcher prefers the repo-local `dist/cli.js` so a checkout works without `npm link`. A packaged install resolves the global bin instead.

---

## Phase 8 — Verification and documentation

### Done

- [x] `README.md` — dual-interface introduction, prerequisites, MCP setup, Skill install, direct CLI usage, examples, configuration table, error codes, limitations, architecture, and development commands.
- [x] `.env.example`, `examples/vscode-mcp.json`, `.prettierrc.json`, `.prettierignore`, `.oxlintrc.json`, `vitest.config.ts`.
- [x] `npm run check` (`typecheck` → `lint` → `test` → `format:check`) passes.
- [x] MCP stdio binary verified with a real `initialize` handshake — responds with the server instructions and capabilities.

### Test results

```
Test Files  13 passed (13)
Tests       125 passed (125)
```

| Area                 | Coverage                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                 | config parsing/validation, `.env` parsing and precedence, MIME mapping, SSRF address classification, timestamp parsing, JSON extraction, redaction region normalization, Gemini upload/poll/reuse/timeout/coalescing, CLI arg parsing and error envelopes |
| Contract             | CLI and MCP expose identical names, schemas, descriptions, and handlers from one registry; no generative tools                                                                                                                                            |
| Integration (ffmpeg) | metadata, `file://` URIs, audio-only detection, even/interval/timestamp/scene frame extraction, pagination, blur/pixelate/blackout rendering, preview frames, source-overwrite refusal, consent gating                                                    |
| Integration (MCP)    | tool listing, schema publication, error containment, real `get_video_info` call over an in-memory transport                                                                                                                                               |
| Skill                | frontmatter, discoverability, file-budget, referenced files, launcher list + error paths                                                                                                                                                                  |

### Bugs found and fixed during implementation

1. Explicit output directories were not created before invoking ffmpeg (`extract_frames`, `redact_sensitive`).
2. `-vsync` was removed in ffmpeg 9; scene detection now uses a two-pass `showinfo` timestamp scan plus per-timestamp extraction, which also works on ffmpeg 5–8.
3. `extract_frames` trimmed extraction to the current page, making pagination unreachable — it now extracts the full requested set.
4. The `search_timestamp` parser missed space-separated ranges (`MATCH 42.5 47.0 — …`).
5. IPv6 compression expansion inserted `undefined` placeholders instead of zeros, misclassifying all compressed IPv6 addresses as private; IPv4-embedded forms (`::ffff:8.8.8.8`) were also unparsed.
6. `runCli` blocked reading `process.stdin` under test; stdin reading is now an injectable `CliIO` capability.
7. `help <operation>` fell through to the general usage text.

### Deliberate deviations from the plan

- **Linting uses oxlint.** `typescript-eslint@8` refuses to load on TypeScript 7, so ESLint cannot parse this project (details below).
- **MCP schema violations surface as JSON-RPC `-32602`.** The MCP SDK validates arguments against the shared Zod schema before the handler runs, so users see the SDK's field-level message rather than our `INVALID_INPUT` envelope. The CLI path does emit `INVALID_INPUT`. Both are actionable and name the offending field.
- **AI redaction detects whole-video regions.** Detected regions have no time bounds; callers can add `startTime`/`endTime` manually.
- **No live Gemini test.** No API key was available. Every Gemini code path is covered through the `GeminiApi` interface with mocked SDK behaviour; a `tests/live/` opt-in suite is still to be added.

## Linting

**Tool: oxlint 1.90** (`npm run lint`, `npm run lint:fix`). Scope: `src`, `tests`, `skills`.

### Why not ESLint

| Check                                                     | Result                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm install -D eslint typescript-eslint`                 | `ERESOLVE` — `typescript-eslint@8.72.1` declares peer `typescript: ">=4.8.4 <6.1.0"`; this repo uses TypeScript 7.0.2 |
| Install with `--legacy-peer-deps`, then import the parser | Hard failure: `typescript-eslint does not support TS 7.0.` (deliberate runtime guard, upstream issue #10940)          |

ESLint itself is fine; it cannot parse TypeScript without `typescript-eslint`. oxlint was chosen because it parses TypeScript itself with no dependency on the compiler API, and it is lint-only, so the existing Prettier setup is untouched (Biome would have forced a repo-wide reformat).

**Accepted gap:** no type-aware rules — `no-floating-promises`, `no-misused-promises`, and similar are unavailable. `tsc --strict` covers nullability and exhaustiveness but not unawaited promises.

### Configuration highlights

- `correctness` = error, `suspicious`/`perf` = warn; plugins `typescript`, `unicorn`, `import`, `node`, `promise`.
- `no-console` is an **error**: stdout must stay machine-readable for the CLI envelope and the MCP stdio transport.
- `no-await-in-loop` is **off** with intent: ffmpeg frame extraction runs sequentially to avoid spawning a hundred processes, and the Gemini upload poll loop is inherently sequential.
- `.oxlintrc.json` is formatted by Prettier like any other config file.

### Findings addressed in the first clean-up pass

| Finding                                 | Fix                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `promise/always-return` in `src/cli.ts` | Entry point now uses top-level `await` with `try`/`catch`                 |
| `unicorn/consistent-function-scoping`   | Hoisted `pad()` out of `formatTimestamp()`                                |
| `unicorn/prefer-array-find`             | `split().map().filter(Boolean).pop()` → `split().map().findLast(Boolean)` |
| `unicorn/no-array-sort` (×3)            | `.sort()` → `.toSorted()`                                                 |

Final state: **0 errors, 0 warnings** across all linted paths.

## Environment / key loading

`src/utils/dotenv.ts` adds minimal `.env` support so the "how do I supply `GEMINI_API_KEY`?" question has a concrete answer beyond shell profiles.

- Read once from `process.cwd()/.env` when `loadConfig()` is called with the real `process.env`; callers passing an explicit env object (tests, embedders) are unaffected.
- Real environment variables always win — `.env` only fills unset or blank values.
- Missing file, malformed lines, and comments never abort startup; escape sequences are not interpreted.
- `loadConfig(env, { dotenvFile })` can point elsewhere, and `dotenvFile: null` disables it.

**Why it mattered:** `.env.example` previously claimed to be copied to `.env`, but nothing read that file — the documentation promised behaviour that did not exist. Either the doc or the code had to change; adding the loader was the smaller surprise.

Verified end to end: a temp cwd containing only `.env` yields the key (`PASS`), and a pre-set shell variable wins over the file (`PASS`).

**Interface distinction now documented:** an MCP config `env` block applies only to the MCP server. The Skill launcher spawns the CLI with no `env` override, so it inherits the agent's shell environment and never reads MCP config.

**Windows environment variables** are documented as an alternative to `.env`. Verified on this machine with a throwaway variable: `[Environment]::SetEnvironmentVariable(...,'User')` was readable from the registry immediately, while the already-running process reported `undefined` — confirming that a **VS Code restart** is required, and that restarting only the terminal is insufficient (the terminal inherits VS Code's snapshot, not the registry). Docs also warn against quoted values and trailing spaces, both of which silently break the key.

## Remaining Follow-ups

- Opt-in live Gemini test suite (guarded by `GEMINI_API_KEY`, skipped by default).
- Revisit ESLint once `typescript-eslint` supports TypeScript 7 (tracked upstream), to regain type-aware rules.
- Optional persistent file-reference cache if repeated-process uploads become a cost issue.
- Optional SRT/VTT output if Gemini ever exposes reliable per-cue timings.
