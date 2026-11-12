# Codebase review — video-analyzer

- **Reviewed:** 2026-11-12
- **Commit:** `b9e0ed8` (`feature/yt-dlp`), working tree clean apart from this document
- **Environment:** Windows, Node.js 26.11.1, `@google/genai` 2.32.0, TypeScript 7.0.2, oxlint 1.90.0
- **Scope:** every file under `src/` (30 files, ~4.9k lines), all 23 test files and their helpers (~5.2k lines), the Skill package, and the user-facing documentation
- **Method:** full read of the source and tests, followed by `npm run typecheck`, `npm run lint`, and `npm test`
- **Supersedes:** the live-run findings recorded at HEAD; that review's open P3 (summary timestamps) is carried forward as F3

> **Update (2026-11-12):** all findings below were resolved in the same working tree.
> The status column and the resolution log (§13) record what changed; §3–§9 describe the
> code as reviewed.

## Verdict

This is a small, disciplined TypeScript toolkit that does one job well. A single operation
registry feeds three interfaces (CLI, MCP server, and an agent Skill that shells out to the
CLI), so capability drift between them is structurally impossible and is asserted by a
contract test. The error model, cancellation handling, temporary-file lifecycle, and SSRF
defence are all stronger than the size of the project suggests.

No blocking (`P1`) defects were found. The executable paths are correct, the documented
limits match the schemas, and the full suite is green. Two documentation statements were
stale in ways that change what an agent or a reader would do (`P2`), and there was a set of
small `P3` polish items: one missing warning, one misleading summary line, a few CLI and
library ergonomics gaps, and the absence of CI. All twelve are resolved; see §13.

## 1. What the project is

`video-analyzer` analyzes video and audio files with Gemini (for AI work) and FFmpeg/ffprobe
(for local work). It deliberately excludes generation, multi-provider routing, and licensing.

| Operation          | Purpose                                                   | Gemini | Writes files |
| ------------------ | --------------------------------------------------------- | ------ | ------------ |
| `analyze_video`    | Answer one question about picture and audio               | yes    | no           |
| `summarize_video`  | Overview, key moments, dialogue/text, tone, gaps          | yes    | no           |
| `search_timestamp` | Locate when something happens (estimates, not frame cuts) | yes    | no           |
| `transcribe_video` | Plain-text speech-to-text, optionally to a file           | yes    | optional     |
| `get_video_info`   | Duration, resolution, fps, codecs, size                   | no     | no           |
| `extract_frames`   | Frames by count, interval, timestamps, or scene change    | no     | yes          |

Inputs may be local paths, `file://` URIs, direct HTTP(S) media URLs, or platform page URLs
(YouTube, Vimeo, …), which are resolved through `yt-dlp`.

## 2. Repository layout

```text
src/
  cli.ts, mcp.ts, index.ts, config.ts, version.ts   entry points and configuration
  adapters/     cli.ts, envelope.ts, mcpServer.ts, mcpTools.ts
  operations/   one module per operation + registry.ts, execute.ts, shared.ts, types.ts
  services/     ffmpeg.ts, gemini.ts, mediaInput.ts, ytdlp.ts
  utils/        abort.ts, dotenv.ts, errors.ts, fsUtils.ts, logger.ts, mime.ts, net.ts
tests/
  unit/         19 files, isolated behaviour with injected fakes
  integration/  2 files, real ffmpeg fixtures and an in-memory MCP client
  contract/     CLI/MCP parity assertions
  skill/        drives the packaged launcher in dist/
skills/video-analyzer/
  SKILL.md, references/{operations,configuration,troubleshooting}.md, scripts/invoke.mjs
```

## 3. Architecture

### 3.1 Layers

```text
MCP client ──> adapters/mcpServer + mcpTools ─┐
                                             ├──> operations/registry ──> operations/*.run
Agent Skill ──> scripts/invoke.mjs ──> adapters/cli ─┘                        │
                                                                              ▼
                                                              services: mediaInput -> ytdlp | net
                                                                        ffmpeg, gemini
```

The registry ([registry.ts](../../src/operations/registry.ts#L17)) is the only list of
capabilities. Both adapters iterate it, and each operation carries its own Zod schema,
description, and MCP hints (`readOnly`, `destructive`), so an interface cannot expose a
capability the other lacks — or a different schema for it.

`OperationResult` ([types.ts](../../src/operations/types.ts#L25)) is interface-neutral:
`summary` is always present, with optional `data`, `warnings`, `images`, and `artifacts`.
Each adapter renders that into its own shape (JSON envelope for the CLI, MCP content blocks
for the server).

### 3.2 Module responsibilities

| Area                                    | Responsibility                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adapters/cli.ts`                       | Argument parsing, input from `--input`/`--input-file`/stdin, JSON envelope, Ctrl-C cancellation, exit codes |
| `adapters/mcpServer.ts` + `mcpTools.ts` | Tool registration, logging notifications, cancellation forwarding, image inlining budget                    |
| `adapters/envelope.ts`                  | Shared result envelope and bounded base64 image loading                                                     |
| `operations/*.ts`                       | Per-capability schema, prompt, validation, and result shaping                                               |
| `operations/shared.ts`                  | Media preparation, Gemini service reuse, artifact directories, formatting helpers                           |
| `services/mediaInput.ts`                | Path/URI/URL resolution; delegates page URLs to yt-dlp                                                      |
| `services/net.ts`                       | SSRF-hardened downloads: DNS validation, per-hop redirect checks, size caps                                 |
| `services/ffmpeg.ts`                    | ffprobe metadata, four frame-extraction strategies, frame budgets                                           |
| `services/gemini.ts`                    | Upload → poll → generate pipeline, content-hash cache, coalescing, deadlines                                |
| `utils/*`                               | Stable error model, timer clamping, `.env` parsing, temp-dir ownership, logging, MIME mapping               |

### 3.3 One request end to end (`analyze_video`)

1. CLI parses arguments and validates the payload against the operation schema
   ([execute.ts](../../src/operations/execute.ts#L49)).
2. `assertGeminiAvailable` fails fast if no key exists — before any download or ffprobe work
   ([shared.ts](../../src/operations/shared.ts#L40)).
3. `prepareMedia` resolves the input: local path → `file://` URI → HTTP(S). A remote URL is
   downloaded into a per-request temp directory, and an HTML response is handed to `yt-dlp`
   ([mediaInput.ts](../../src/services/mediaInput.ts#L231)).
4. ffprobe reads duration and stream metadata (ignoring `attached_pic` cover art).
5. `GeminiMediaService.generateWithFile` uploads (or reuses a content-identified upload),
   waits for `ACTIVE`, then sends the file URI plus the prompt.
6. The result is shaped into `summary`/`data`; `finally` removes the temp directory.
7. The adapter renders a JSON envelope (CLI) or text/image content blocks (MCP).

## 4. Operation catalogue

| Operation          | Inputs                                                                                                                         | Notable behaviour                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `analyze_video`    | `videoPath`, `question`                                                                                                        | Analyst system prompt forbids invented scenes, dialogue, and timestamps          |
| `summarize_video`  | `videoPath`, optional `focus`                                                                                                  | Fixed five-section prompt; asks for approximate timestamps (see F3)              |
| `search_timestamp` | `videoPath`, `query`                                                                                                           | Strict `MATCH <start> <end> — description` parsing; out-of-range results flagged |
| `transcribe_video` | `videoPath`, `language`, `translateToEnglish`, `outputPath`, `overwrite`                                                       | `NO_SPEECH` sentinel; `.srt`/`.vtt` refused rather than fabricated               |
| `get_video_info`   | `videoPath`                                                                                                                    | `readOnly: true`; warns for audio-only input                                     |
| `extract_frames`   | `videoPath` or `frameSetDir`, `mode`, `count`/`intervalSec`/`timestamps`, `sceneThreshold`, `maxImages`, `offset`, `outputDir` | Persists a `frame-NNNN.jpg` set with a manifest; paging never re-extracts        |

## 5. Cross-cutting design

### 5.1 Error model

Every expected failure is a `VideoAnalyzerError` with a stable code, message, optional hint,
and structured details ([errors.ts](../../src/utils/errors.ts)). Unknown throws are normalised
to `INTERNAL`, aborts become `OPERATION_CANCELLED`, and adapters never leak stack traces or
URL credentials (`redactedUrl`). Hints name the setting that actually applied — for example a
shortened upload budget reports `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, not the generic request
timeout.

### 5.2 Configuration and the `.env` trust boundary

[config.ts](../../src/config.ts#L109) parses a typed `Config` with validated integer, boolean,
and string readers. `.env` files are treated as untrusted repository content: only
`DOTENV_KEYS` may be contributed, and binaries (`FFMPEG_PATH`, `FFPROBE_PATH`, `PATH`),
`VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`, `VIDEO_ANALYZER_CLI_PATH`, and all `YT_DLP_*` settings
must come from the real environment. This closes the obvious escalation path where a cloned
repository chooses which executable runs.

Durations are clamped to `2^31 - 1` ms ([abort.ts](../../src/utils/abort.ts#L18)) instead of
being handed to Node's timers, where an oversized delay silently fires after 1 ms.

### 5.3 Cancellation and deadlines

`runWithBounds` races the work against a deadline and the caller's signal, and hands the work
a combined signal so the underlying socket or subprocess actually stops. A stalled client
library cannot hang the operation because the promise settles when either bound fires.
Cancellation is classified before any media/network/disk failure, both in FFmpeg calls and in
downloads, so Ctrl-C never reads as "your video is corrupt".

The Gemini SDK's upload path drops `config.abortSignal`, so uploads run inside an
`AsyncLocalStorage` and a wrapped `fetch` applies the bound signal to every request the SDK
makes — including the chunk transfer ([gemini.ts](../../src/services/gemini.ts#L92)).

### 5.4 Temporary files and cleanup

Downloads land in `mkdtemp` directories carrying an ownership marker (`pid`). Cleanup is
best-effort and logged. At startup, `sweepStaleTempDirs`
([fsUtils.ts](../../src/utils/fsUtils.ts#L54)) removes only old, marked directories whose
owner has exited (`kill(pid, 0)` → `ESRCH`), never unmarked or foreign entries — a
conservative design that avoids deleting another tool's data.

Frame extractions get a fresh artifact folder per request, and a failed extraction removes
the whole folder so a reported `data.outputDir` is always complete.

### 5.5 Upload reuse and coalescing

Uploads are cached by a content identity (SHA-256 for downloads), not by path, because a path
plus size/mtime cannot prove identical content. Concurrent requests for the same identity
share one in-flight upload with reference-counted source retention, so a direct download is
not deleted while the shared upload still needs it. Mutable local files are intentionally
never cached or coalesced (documented limitation).

### 5.6 Media resolution policy

A URL that returns `text/html`/XHTML is treated as a platform page and handed to yt-dlp after
the tool's own SSRF check; JSON and image responses are rejected instead. Downloads are
capped by declared length and by a streaming byte counter, and the MIME type must be a media
type — a header-less image is not silently accepted as video.

## 6. Security review

| Area                | Control                                                                                                                                                                                       | Assessment                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| SSRF                | Hostname blocklist, DNS resolution of every hop, private/reserved IPv4+IPv6 ranges, per-redirect validation with a pinned `lookup`, credentials rejected                                      | Strong                               |
| Redirect abuse      | `redirect: 'manual'`, max 5 hops, each hop re-validated, URL redacted in errors                                                                                                               | Strong                               |
| `.env` injection    | Allowlist of non-privileged keys; binaries, PATH, network policy, and CLI path are environment-only                                                                                           | Strong                               |
| `yt-dlp` execution  | `execFile` (no shell), fixed argument vector, `--ignore-config` blocks user config `--exec`, size and resolution caps, first playlist item only                                               | Strong with documented residual risk |
| File overwrite      | Transcript targets refuse the source media (canonical + dev/inode check), refuse directories, refuse existing files unless `overwrite: true`; `wx` flag plus staged rename for atomic replace | Strong                               |
| Secrets             | No secrets in logs; download URLs stripped of credentials/query; API keys read only from env                                                                                                  | Good                                 |
| Temp files          | Unique per-request directories, marker file with mode `0600`, conservative sweep                                                                                                              | Good                                 |
| Untrusted manifests | Frame-set manifest is size-capped, schema-validated, and its file names are constrained to `frame-NNNN.jpg`                                                                                   | Good                                 |
| Prompt injection    | Media content is inherently untrusted; system prompts forbid invention. Manifest `warnings` text from a foreign frame set is echoed to the model, a low-risk residual                         | Acceptable                           |
| Dependencies        | Four runtime packages, all mainstream; no post-install scripts                                                                                                                                | Good                                 |

Residual risks are documented rather than hidden: yt-dlp makes its own network requests that
the SSRF guard does not cover, uploaded media is retained by Gemini (~48 h), and AI operations
send media off the machine.

## 7. Correctness details worth noting

The implementation anticipates failure modes that reviews usually have to find:

- Cover art (`disposition.attached_pic`) is excluded from both metadata and stream mapping, so an MP3 with artwork is reported as audio-only and rejected by `extract_frames`.
- Frame extraction maps the probed absolute stream index, not `0:v:0`, so a second real video stream is honoured consistently across all four modes.
- Scene detection retries with `-vsync 0` only when the error names `fps_mode`, and asks for one frame beyond the budget so "truncated" is provable.
- `timestamps` mode validates every value against the duration before the first subprocess, then falls back to a `tpad` clone for seeks at or past EOF.
- `formatTimestamp` rounds once in integer milliseconds, avoiding `.1000` output.
- A Gemini response is rejected unless `finishReason === 'STOP'`, and `response.text` emptiness is reported explicitly.
- Upload requests deliberately omit `httpOptions` because supplying them replaces the resumable-upload defaults.
- Frame paging re-validates every file and reports frames that vanished from disk as `INVALID_INPUT`.
- MCP inlining stops at a 2 MiB base64 budget and reports the remaining frames by path instead of failing the call.
- The Skill launcher stages JSON in a temp file when it must go through `cmd.exe`, so `&`, `|`, and `^` survive (covered by a Windows-only test).

## 8. Test suite

`npm test` (which builds first) reports **25 files, 340 passed, 2 skipped (~16 s)**. The
review baseline was 23 files and 336 passing tests; the added suites are the
`summarize_video` envelope test and the opt-in live check described below.

| Layer       | Files | What it proves                                                                                                                                               |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | 20    | Schemas, config/`.env`, CLI parsing and payload limits, Gemini upload/cache/timeouts/transport, SSRF, frame budgets, transcript safety, MIME, abort, fsUtils |
| Integration | 3     | Real ffmpeg-generated fixtures (25 tests), a real in-memory MCP client (7 tests), and the opt-in live Gemini check (1 test)                                  |
| Contract    | 1     | CLI/MCP name, description, and schema identity; read-only/destructive annotations; no generative tools                                                       |
| Skill       | 1     | Packaged launcher discovery, envelopes, UTF-8 chunking, Windows `cmd` metacharacter handling                                                                 |

The two skipped cases are one platform-dependent filesystem feature (symlink/hard-link/case
sensitivity), which the tests detect and skip rather than fail, and the opt-in live Gemini
test. The live test requires `VIDEO_ANALYZER_LIVE_TEST=1` plus a key, passed against the real
API in this environment, and stays skipped in ordinary runs so a transient network failure
cannot break the suite.

Gaps:

- No coverage measurement configured.
- The Windows `cmd.exe` shim path is only tested for metacharacters, not for a payload path containing spaces (residual gap, no finding assigned).

## 9. Documentation

The README (~490 lines), the Skill, and the reference documents are unusually complete:
defaults, error codes, trust-boundary rules, and known limitations match the implementation.
Spot checks confirmed the documented ranges against the schemas (`count` 1–500, `timestamps`
≤ 100, `intervalSec` ≥ 0.1, `maxImages` 1–100, `sceneThreshold` 0.05–0.95).

Two statements contradicted the shipped behaviour, and one list was incomplete (all three
were corrected; see F1, F2, and F11):

- [operations.md](../../skills/video-analyzer/references/operations.md#L19) said platform downloads and the yt-dlp fallback were disabled.
- [findings-and-plan.md](../../findings-and-plan.md#L3) stated that yt-dlp was unused.
- The CLI usage block listed the Gemini, frame, timeout, and binary settings but omitted the four `YT_DLP_*` settings, even though page URLs are accepted.

Both stale statements predated the platform-download change and were missed when the README
and `SKILL.md` were updated.

## 10. Findings

Severity: `P1` release-blocking defect, data loss, or security hole · `P2` wrong behaviour
through a shipped interface (including agent instructions) · `P3` polish, ergonomics, or
process gap.

| ID  | Severity | Area              | Finding                                                                             | Status      |
| --- | -------- | ----------------- | ----------------------------------------------------------------------------------- | ----------- |
| F1  | P2       | Skill docs        | Operation reference says platform downloads are disabled                            | ✅ Resolved |
| F2  | P3       | Historical docs   | Design-document banner says yt-dlp is unused                                        | ✅ Resolved |
| F3  | P3       | `summarize_video` | No warning about approximate timestamps                                             | ✅ Resolved |
| F4  | P3       | `extract_frames`  | Paging a saved frame set is reported as a fresh extraction                          | ✅ Resolved |
| F5  | P3       | CLI               | Unknown options are silently ignored                                                | ✅ Resolved |
| F6  | P3       | Process           | No CI workflow despite an `npm run check` gate                                      | ✅ Resolved |
| F7  | P3       | Library API       | `loadConfig()` mutates `process.env`                                                | ✅ Resolved |
| F8  | P3       | CLI               | No size cap on stdin / `--input-file` payloads                                      | ✅ Resolved |
| F9  | P3       | Library API       | The `geminiService` seam cannot be used through `executeOperation`                  | ✅ Resolved |
| F10 | P3       | Tests             | No opt-in live-provider smoke test                                                  | ✅ Resolved |
| F11 | P3       | CLI docs          | Usage text omits the `YT_DLP_*` settings                                            | ✅ Resolved |
| F12 | P3       | Workspace         | 98 frame-set folders plus a `timestamp-check` directory in `video-analyzer-output/` | ✅ Resolved |

### F1 — P2 — Skill operation reference contradicts the platform-download feature

**Status:** ✅ Resolved — [operations.md](../../skills/video-analyzer/references/operations.md#L19) now lists platform page URLs and describes automatic yt-dlp handling, `DEPENDENCY_MISSING`, and the `YT_DLP_*` limits.

[operations.md](../../skills/video-analyzer/references/operations.md#L19) states:

> Platform page downloads and yt-dlp fallback are disabled; use a local file or a direct media URL.

The implementation does the opposite: [mediaInput.ts](../../src/services/mediaInput.ts#L118)
hands an HTML response to `downloadFromPlatform`
([ytdlp.ts](../../src/services/ytdlp.ts#L213)), the README documents it in "Getting Media from a
Platform", `SKILL.md` tells the agent page URLs are supported, and
`tests/unit/mediaInput.test.ts` asserts that a platform page is extracted rather than rejected.

Impact: `operations.md` is the argument reference an agent loads after choosing an operation.
An agent following it will refuse the most common real-world input (a YouTube link) and tell
the user to download the file manually, even though the tool would succeed.

Recommendation: replace the sentence with the current behaviour — page URLs are downloaded
automatically with `yt-dlp`; a missing binary is `DEPENDENCY_MISSING`; settings are the
`YT_DLP_*` variables — and link [configuration.md](../../skills/video-analyzer/references/configuration.md#L124)
and the README section.

### F2 — P3 — Design-document banner is stale

**Status:** ✅ Resolved — the banner now states that platform downloads are enabled and describes the current yt-dlp behaviour.

The "Superseded" banner at [findings-and-plan.md](../../findings-and-plan.md#L3) says platform
page downloads are disabled and the `YT_DLP_*` settings are unread. They are read, validated,
and used. Since the file is explicitly historical, the banner is the only part most readers
will trust; it taught the opposite of the product's behaviour.

Recommendation: update that bullet (and the "no 720p cap" note, which is now a configurable
`YT_DLP_MAX_RESOLUTION` default) while keeping the historical framing.

### F3 — P3 — `summarize_video` timestamps carry no warning

**Status:** ✅ Resolved — `TIMESTAMP_ESTIMATE_WARNING` is attached to every summary and covered by `tests/unit/summarizeVideo.test.ts`.

[summarizeVideo.ts](../../src/operations/summarizeVideo.ts#L21) asks the model for
"approximate" timestamps and instructs it to say "timestamp approximate", but the result adds
no `warnings` entry, unlike `search_timestamp`, which warns unconditionally. Agents are
instructed to relay warnings when they affect trust; a summary is exactly where a timestamp
estimate is most likely to be quoted as fact. This was recorded as open in the previous live
review and is fixed by the resolution in §13.

Recommendation: attach the same estimate warning, or drop timestamps from the summary
contract.

### F4 — P3 — Frame paging is described as extraction

**Status:** ✅ Resolved — paging now reports `Returned frames X-Y of N from <dir>`; asserted in `tests/unit/extractFrames.test.ts`.

`renderFramePage` ([extractFrames.ts](../../src/operations/extractFrames.ts#L138)) always
summarises as `Extracted N frame(s) (mode: X) into <dir>`, including the `frameSetDir` path
where no extraction, download, or ffmpeg run happened. The operation reference explicitly
promises that paging "reads the saved frame set without accessing the source".

Recommendation: when `frameSetDir` was supplied, summarise as
`Returned frames <start>–<end> of N from <dir>` so agents do not report phantom work.

### F5 — P3 — Unknown CLI options are ignored

**Status:** ✅ Resolved — unknown options fail with `INVALID_INPUT` and a list of supported flags; covered in `tests/unit/cli.test.ts`.

[parseArgs](../../src/adapters/cli.ts#L116) appends anything it does not recognise to `rest`,
and `runCli` only reads `rest` for `help`. As a result:

- `video-analyzer get_video_info --inputfile args.json` loses the value and fails with "requires arguments".
- `video-analyzer get_video_info --input '{...}' --prety` silently omits pretty output.

A typo therefore either fails with an unrelated message or passes unnoticed.

Recommendation: reject unknown `--`-prefixed options as `INVALID_INPUT` with a hint listing
the valid flags, and add a unit test next to the existing `parseArgs` cases.

### F6 — P3 — No CI

**Status:** ✅ Resolved — `.github/workflows/ci.yml` runs `npm run check` on Node 22 with FFmpeg for pushes to `main` and for pull requests.

`.github/workflows/` exists but contains no files, so the `npm run check` gate — typecheck,
lint, build, tests, and format check — is only enforced by convention. The repository's own
history shows repeated "resolve codebase review findings" commits; a workflow would prevent
the classes of regression those fix (schema/documentation drift, parity drift).

Recommendation: a workflow on push and pull request running `npm ci` and `npm run check`,
installing ffmpeg so the integration layer runs instead of skipping.

### F7 — P3 — `loadConfig()` writes to `process.env`

**Status:** ✅ Resolved — the `loadConfig` JSDoc and README now document the side effect and the explicit-environment alternative.

[config.ts](../../src/config.ts#L144) applies `.env` into `process.env` whenever the default
environment is used. That is exactly what the CLI and MCP server want, but the function is
also exported from the package entry point, where mutating global process state is a
surprising side effect for an embedder.

Recommendation: document the side effect explicitly (or add an opt-out), and mention it in
the embedding section of the README.

### F8 — P3 — Unbounded CLI payload reads

**Status:** ✅ Resolved — `MAX_INPUT_BYTES` (1 MiB) caps `--input`, `--input-file`, and stdin; covered in `tests/unit/cli.test.ts`.

`readStdinToEnd` accumulates every chunk, and `--input-file` uses `readFile`, so an arbitrarily
large payload is buffered before JSON parsing. The caller is local and already trusted, so
this is a robustness issue rather than a vulnerability.

Recommendation: cap the payload (a few MB is far beyond any legitimate schema) and return
`INVALID_INPUT` naming the limit.

### F9 — P3 — The documented service seam is unreachable through the public wrapper

**Status:** ✅ Resolved — `ExecuteOptions.geminiService` is forwarded into the operation context and exercised through `executeOperation`.

`OperationContext.geminiService` is documented as a test seam
([types.ts](../../src/operations/types.ts#L40)), but `executeOperation`
([execute.ts](../../src/operations/execute.ts#L49)) never sets it and `ExecuteOptions` has no
field for it. Tests that need a fake service call `operation.run(input, ctx)` directly, which
bypasses the shared schema validation and logging they would otherwise get.

Recommendation: add `geminiService` to `ExecuteOptions` and forward it, so embedders and tests
can keep using the validated entry point.

### F10 — P3 — No opt-in live-provider test

**Status:** ✅ Resolved — `tests/integration/liveGemini.test.ts` runs under `VIDEO_ANALYZER_LIVE_TEST=1` and passed against the real API.

The `GeminiApi` seam is the right design and is thoroughly tested, but nothing in the
repository exercises the real SDK wiring (model id, resumable upload, `finishReason`,
`expirationTime` parsing). The last confirmation is a manual run recorded in the previous
review.

Recommendation: a suite gated on `GEMINI_API_KEY` (`describe.skipIf`) that generates a
two-second clip with ffmpeg, runs `analyze_video`, and asserts a non-empty summary.

### F11 — P3 — CLI usage omits the yt-dlp settings

**Status:** ✅ Resolved — `video-analyzer help` lists all four `YT_DLP_*` variables as environment-only.

`CLI_USAGE` in [adapters/cli.ts](../../src/adapters/cli.ts#L62) lists every Gemini, frame,
timeout, output, binary, and `.env`-restriction setting, but not `YT_DLP_PATH`,
`YT_DLP_MAX_RESOLUTION`, `YT_DLP_COOKIES_FILE`, or `YT_DLP_IMPERSONATE`. Someone who reads
`video-analyzer help` to debug a platform 403 will not learn about cookies or impersonation.

Recommendation: list the `YT_DLP_*` variables (environment-only, as with the binaries) and a
one-line pointer to the README section.

### F12 — P3 — Generated artifacts left in the workspace

**Status:** ✅ Resolved — generated frame folders were removed, and the frame tests now write into per-test temp directories.

`video-analyzer-output/` contains 98 `frames-*` folders plus a `timestamp-check` directory
(~0.9 MB in total) and a transcript, and `test-videos/` holds ad-hoc media. Both roots are
git-ignored, so the repository is unaffected, but they slow down searches and can confuse
path-based tooling.

Recommendation: delete when not needed; the tool already sweeps its OS temp directories, and
frame sets are intentionally persistent until removed.

## 11. Strengths

- One registry, three interfaces, enforced by a contract test — no duplicated tool definitions.
- Hints and error codes are designed for both humans and agents; the troubleshooting document is organised by code.
- Cancellation, deadlines, and cleanup are treated as first-class across FFmpeg, downloads, and Gemini.
- Security controls are layered and documented, including their residual risk (yt-dlp, Gemini retention).
- The `.env` trust boundary is a genuinely thoughtful mitigation for agent-driven tools.
- Tests generate media at runtime instead of committing binaries, and platform-dependent cases skip explicitly.
- Documentation states limits honestly (approximate timestamps, inlining budget, frame budgets) rather than overselling.

## 12. Recommended next steps

1. Fix F1 and F2 (documentation truth) — smallest change, largest behavioural payoff.
2. Fix F4 and F3 (two misleading output signals) — a few lines each, with tests.
3. Tighten the CLI: unknown-option rejection (F5), payload cap (F8), yt-dlp settings in usage (F11).
4. Add the `npm run check` workflow (F6) and the opt-in live smoke test (F10).
5. Consider the library API items (F7, F9) when the embedding surface is next touched.

## 13. Resolution log

All findings were fixed in the working tree on 2026-11-12 and verified with
`npm run typecheck`, `npm run lint`, `npm test`, and `npx prettier --check .`.

| ID  | Change                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | [operations.md](../../skills/video-analyzer/references/operations.md#L19) now lists platform page URLs and explains automatic yt-dlp handling, `DEPENDENCY_MISSING`, and the `YT_DLP_*` limits.                                                                                                               |
| F2  | The [findings-and-plan.md](../../findings-and-plan.md#L3) banner now states that platform downloads are enabled and describes the yt-dlp behaviour.                                                                                                                                                           |
| F3  | `TIMESTAMP_ESTIMATE_WARNING` now lives in [shared.ts](../../src/operations/shared.ts) and is attached by both `summarize_video` and `search_timestamp`; covered by `tests/unit/summarizeVideo.test.ts`.                                                                                                       |
| F4  | `renderFramePage` distinguishes paging from extraction and reports `Returned frames X-Y of N from <dir>`; asserted in `tests/unit/extractFrames.test.ts`.                                                                                                                                                     |
| F5  | `parseArgs` rejects unknown options as `INVALID_INPUT`; covered in `tests/unit/cli.test.ts`.                                                                                                                                                                                                                  |
| F6  | Added `.github/workflows/ci.yml` (`npm ci` plus `npm run check` on Node 22 with FFmpeg, on push to `main` and every pull request).                                                                                                                                                                            |
| F7  | The `loadConfig` JSDoc and the README configuration section document that a `.env` file is applied to `process.env` when the default environment is used.                                                                                                                                                     |
| F8  | CLI payloads are capped at `MAX_INPUT_BYTES` (1 MiB) for `--input`, `--input-file`, and stdin; oversized input reports `INVALID_INPUT` naming the source and the limit.                                                                                                                                       |
| F9  | `ExecuteOptions.geminiService` is forwarded into the operation context; exercised by `tests/unit/summarizeVideo.test.ts`, which injects a service through `executeOperation`.                                                                                                                                 |
| F10 | Added the opt-in `tests/integration/liveGemini.test.ts` (generates a clip, uploads it, asks a question); it requires `VIDEO_ANALYZER_LIVE_TEST=1` plus a key and passed against the real API here.                                                                                                            |
| F11 | `CLI_USAGE` lists the four `YT_DLP_*` settings and notes that they are environment-only.                                                                                                                                                                                                                      |
| F12 | Removed the generated `frames-*` and `timestamp-check` directories from `video-analyzer-output/`, and pointed the frame-extraction unit tests at their per-test temp directory so a suite run no longer recreates them. The regenerable transcript and user-supplied `test-videos/` media were left in place. |

## Appendix A — Configuration reference

| Variable                             | Default              | Source        | Purpose                                           |
| ------------------------------------ | -------------------- | ------------- | ------------------------------------------------- |
| `GEMINI_API_KEY`                     | —                    | env or `.env` | Required for AI operations                        |
| `GEMINI_MODEL`                       | `gemini-3.8-flash`   | env or `.env` | Model for every AI call                           |
| `VIDEO_ANALYZER_MAX_FRAMES`          | `100`                | env or `.env` | Interval/scene frame budget (`0` = hard cap only) |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`     | `2048`               | env or `.env` | Remote download size limit                        |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`  | `300000`             | env or `.env` | Per-call Gemini deadline                          |
| `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`   | `600000`             | env or `.env` | Upload plus wait-for-`ACTIVE` budget              |
| `VIDEO_ANALYZER_POLL_INTERVAL_MS`    | `2000`               | env or `.env` | Upload status poll interval                       |
| `VIDEO_ANALYZER_OUTPUT_DIR`          | working directory    | env or `.env` | Base directory for generated artifacts            |
| `VIDEO_ANALYZER_LOG_LEVEL`           | `warn`               | env or `.env` | `silent`/`error`/`warn`/`info`/`debug`            |
| `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` | `false`              | env only      | Allow private/loopback media hosts                |
| `VIDEO_ANALYZER_CLI_PATH`            | auto                 | env only      | CLI used by the Skill launcher                    |
| `FFMPEG_PATH` / `FFPROBE_PATH`       | `ffmpeg` / `ffprobe` | env only      | Media binaries                                    |
| `YT_DLP_PATH`                        | `yt-dlp` from PATH   | env only      | Platform downloader                               |
| `YT_DLP_MAX_RESOLUTION`              | `720`                | env only      | Highest downloaded video height (144–4320)        |
| `YT_DLP_COOKIES_FILE`                | —                    | env only      | Netscape cookies for authenticated media          |
| `YT_DLP_IMPERSONATE`                 | —                    | env only      | Client passed to `--impersonate`                  |

## Appendix B — Error codes and their sources

| Code                       | Raised by                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `INVALID_INPUT`            | Schema validation, option/target checks, `.env` and timeout parsing                  |
| `CONFIG_MISSING`           | `requireGeminiApiKey` when an AI operation runs without a key                        |
| `DEPENDENCY_MISSING`       | Missing `ffmpeg`, `ffprobe`, or `yt-dlp` binary                                      |
| `INPUT_NOT_FOUND`          | Missing local file, unreadable `--input-file`, unreadable stdin                      |
| `UNSUPPORTED_INPUT`        | Non-media MIME type, empty file, audio-only frame extraction, unsupported yt-dlp URL |
| `URL_REJECTED`             | Invalid protocol, embedded credentials, private/reserved host, DNS failure           |
| `DOWNLOAD_FAILED`          | HTTP errors, redirect failures, size/timeout limits, yt-dlp failures                 |
| `MEDIA_PROCESSING_FAILED`  | ffprobe/ffmpeg failures, unmeasurable duration, missing output frame                 |
| `GEMINI_UPLOAD_FAILED`     | Upload rejected or no file identifier returned                                       |
| `GEMINI_PROCESSING_FAILED` | Gemini reports `FAILED` or status cannot be read                                     |
| `GEMINI_REQUEST_FAILED`    | Generation failure, empty response, non-`STOP` finish reason                         |
| `GEMINI_TIMEOUT`           | Per-call deadline or upload/processing budget exhausted                              |
| `OUTPUT_FAILED`            | Artifact directory, frame manifest, or transcript write failure                      |
| `OPERATION_CANCELLED`      | Caller signal (Ctrl-C, MCP cancellation, embedding signal)                           |
| `INTERNAL`                 | Any unexpected throw                                                                 |

## Appendix C — Verification log

```text
$ git rev-parse --short HEAD        b9e0ed8 (findings fixed in the working tree)
$ node --version                    v26.11.1
$ npm run typecheck                 pass (tsc --noEmit, strict + noUncheckedIndexedAccess)
$ npm run lint                      pass (oxlint, no diagnostics)
$ npm test                          25 files, 340 passed, 2 skipped (~16 s)
$ npx prettier --check .            pass
$ node dist/cli.js help             lists the YT_DLP_* settings
$ node dist/cli.js get_video_info --prety
                                    INVALID_INPUT: Unknown option: --prety
$ Get-ChildItem .github/workflows   ci.yml
```
