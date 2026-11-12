# Video Analyzer — Findings and Implementation Plan

> **Superseded.** This is the original design document, kept for rationale. Several
> decisions changed during implementation and are **not** described here:
>
> - **Platform page downloads are enabled.** When a remote URL answers with a
>   document, the tool hands the final URL to `yt-dlp` and analyzes what it
>   downloads. The `YT_DLP_*` environment settings control the executable,
>   resolution cap (720p by default), cookies, and impersonation; there is no
>   licensing gate. The SSRF guard validates only the URL the tool contacts, and
>   direct HTTP(S) media URLs never involve yt-dlp.
> - **No AI-side frame sampling.** The four AI operations send the whole file to
>   Gemini; `VIDEO_ANALYZER_MAX_FRAMES` only affects `extract_frames`.
> - **`transcribe_video` can write a transcript file** (`outputPath`), so it is
>   neither read-only nor non-destructive.
>
> The current behaviour is documented in [README.md](./README.md) and
> [skills/video-analyzer/references/](./skills/video-analyzer/references/).

**Status:** Historical design document — implemented, with the exceptions below

- **Date:** 2026-10-30
- **Reference:** [tugudush/video-context-mcp](https://github.com/tugudush/video-context-mcp)

## 1. Goal

Build a smaller, analysis-focused media toolkit based on the reference project. Offer two equivalent ways to use it:

1. **MCP server:** exposes named tools to MCP-compatible clients.
2. **Agent Skill:** provides an on-demand `SKILL.md` workflow that invokes the same local operations through a CLI, without starting or configuring an MCP server.

Both interfaces are first-class options over one shared application core. The Skill must not call the MCP server, and the MCP server must not depend on the Skill. Neither interface is a reduced or secondary version of the other.

Additional constraints:

- Use **Gemini as the only AI provider** for both video understanding and audio transcription.
- Keep local media utilities where they add value: metadata, frame extraction, and downloading.
- Exclude all generative-media features.
- Make all retained capabilities available without a license key, license validation, or a licensing service.
- Prefer a direct, single-provider pipeline over the reference project's provider-routing and fallback machinery.

The result should be a new lean TypeScript project, not a copy of the reference repository with unused provider code left behind.

## 2. Reference Findings

The reference currently combines two different products in one server:

1. Video/audio analysis: question answering, summaries, timestamp search, transcription, metadata, and frame extraction.
2. Media creation: text-to-speech, image/video/music generation, and asynchronous generation-task polling.

Its analysis architecture is layered as MCP tools → provider orchestrator → provider clients → shared utilities. That separation is useful, but much of the orchestration exists only to support multiple providers and their different file-size, frame, audio, and URL constraints.

Important reference behavior to preserve:

- Gemini accepts native video and audio through the Files API.
- A typical AI request is: resolve input locally → upload → wait until `ACTIVE` → send the file URI and prompt to Gemini.
- Gemini processes video audio natively, so transcript injection into analysis prompts is unnecessary.
- Repeated Gemini upload/processing logic should be centralized rather than duplicated in each tool.
- ffmpeg/ffprobe remain useful for local metadata and frame extraction.
- yt-dlp provides platform URL support; direct HTTP(S) media URLs use a normal download path.
- Temporary downloads and extracted media must be cleaned up in `finally` blocks.

Reference complexity to remove:

- Video and audio provider enums, selection, aliases, fallback chains, and provider-specific retry/deferral branches.
- Non-Gemini SDKs, API keys, model catalogs, and provider-specific size/base64 workarounds.
- The general provider-fallback orchestrator and S3 relay.
- Audio extraction/injection used only to compensate for providers without native audio understanding.
- License keys, cryptographic license verification, device validation, Pro notices, and the license server.
- Generative-media clients, task polling, tool registrations, schemas, types, and tests.
- Update-notification and cache-management CLI functionality unless a later need justifies them.

## 3. Scope

### Delivery options

Users choose either interface; installing both is optional.

| Interface | Best for                                                            | Invocation                                                                      | Runtime requirements                                                   |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **MCP**   | Automatic tool discovery and repeated use by MCP-compatible clients | `analyze_video`, `summarize_video`, and the other registered tools              | Node.js; FFmpeg/yt-dlp where needed; Gemini key only for AI operations |
| **Skill** | A guided, on-demand agent workflow without MCP configuration        | Load the Skill or invoke `/video-analyzer`; its procedure runs the packaged CLI | Same core runtime requirements, but no MCP client or server            |

The Skill is an instruction package, not a standalone AI model. Its bundled scripts perform deterministic work and call Gemini through the shared service. The Skill supplies operation-selection guidance, argument examples, and result interpretation; it does not duplicate media-processing logic in Markdown.

### Included operations

Keep the established analysis-operation names for familiarity, but remove every `provider` parameter. MCP exposes these names as tools; the Skill exposes the same names as CLI subcommands.

| Operation          | Planned behavior                                                                                                            | AI required |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `analyze_video`    | Answer a caller-supplied question about the complete video, including its audio.                                            | Gemini      |
| `summarize_video`  | Produce an overview, key moments with approximate timestamps where supported, important dialogue/text/audio cues, and tone. | Gemini      |
| `search_timestamp` | Locate matching event(s), return all plausible timestamps, and clearly state uncertainty or no match.                       | Gemini      |
| `transcribe_video` | Transcribe spoken audio from an uploaded video/audio file; optionally honor language and translation instructions.          | Gemini      |
| `get_video_info`   | Return duration, dimensions, frame rate, codecs, size, and container metadata.                                              | No          |
| `extract_frames`   | Extract frames by even count, interval, explicit timestamps, or scene changes, with bounded pagination.                     | No          |

### Former-Pro behavior, now standard

- No licensing or feature-tier checks anywhere in the server.
- Platform downloads are not restricted to YouTube; support whatever the installed yt-dlp build can lawfully access.
- No artificial 720p download cap. Allow configurable resolution selection without a license check.
- No 50-frame free-tier ceiling. Default AI-assisted sampling to 100 frames where frame sampling is needed; allow explicit limits and `0` for uncapped sampling, while retaining memory, output-size, and execution-time safeguards.
- Google API quotas, model limits, file expiry, and billing still apply; “unlocked” does not mean unlimited external service usage.

### Explicitly excluded

- Text-to-speech, image generation, video generation, and music generation.
- Generation-task creation, polling, and result downloading.
- MiniMax and all other non-Gemini AI providers.
- Multi-provider fallback and provider-selection configuration.
- License server, license scripts, payment/webhook integrations, and Pro upgrade messaging.
- S3 relay and provider-specific long-video frame fallbacks.
- A GUI, general web research, and persistent multi-turn chat sessions.

Do not register excluded operations as stubs; they should be absent from MCP discovery, Skill guidance, CLI help, and the dependency graph.

## 4. Design Decisions

### 4.1 Runtime and dependencies

- Node.js + TypeScript and ESM for the shared core and CLI.
- The official MCP TypeScript SDK over stdio, imported only by the MCP adapter.
- Zod schemas shared by CLI validation, MCP registration, and handler type inference.
- Official Google GenAI SDK for upload, file-state checks, and content generation.
- ffmpeg/ffprobe for local media operations; yt-dlp only for platform URLs.
- Vitest for unit and integration tests.
- Keep the dependency list small; add libraries only when they replace meaningful complexity.

Use a single verified, current multimodal Gemini model constant at implementation time. Allow `GEMINI_MODEL` to override it. Do not copy a version-specific model ID without checking Google's current model and deprecation documentation.

### 4.2 Shared core and interface adapters

Use one operation registry as the source of truth for names, descriptions, Zod input schemas, and handlers:

```text
MCP client ──> MCP adapter ─┐
                            ├──> operation registry ──> core services ──> Gemini / FFmpeg / yt-dlp
Agent Skill ──> CLI adapter ─┘
```

- Core operations accept validated typed inputs and return a discriminated result envelope containing text/structured data, warnings, and artifact references.
- They must not import MCP types, read CLI arguments, print to stdout, or depend on Skill files.
- The **MCP adapter** registers the same seven operations, maps text/data to MCP content, and converts requested image artifacts to base64 MCP image content.
- The **CLI adapter** exposes matching snake_case subcommands, accepts validated JSON input, emits a stable JSON envelope on stdout, and emits diagnostics only on stderr.
- The CLI never starts or communicates with an MCP server for normal operations. A separate explicit `mcp` command starts the server.
- The Skill invokes the CLI and interprets its output; it contains no second implementation of prompts, validation, uploads, caching, or media logic.
- Both adapters expose identical capabilities and limits. Add interface-specific behavior only at the presentation boundary.

Suggested invocation contract:

```bash
video-analyzer analyze_video --input '{"videoPath":"./demo.mp4","question":"What happens?"}'
video-analyzer get_video_info --input '{"videoPath":"./demo.mp4"}'
video-analyzer mcp
```

Use one documented input mechanism consistently: a JSON argument for simple calls, with `--input-file` or stdin support if Windows command-line length becomes a concern. Do not define a second, drifting set of CLI-only option names.

Successful CLI responses use an envelope such as `{ "ok": true, "operation": "...", "result": ..., "warnings": [] }`; failures use nonzero exit status and `{ "ok": false, "error": { "code": "...", "message": "..." } }`. Keep stdout machine-readable in both cases.

Frame outputs must be written to explicit or managed output locations that survive the call. Return artifact paths and MIME types in the CLI envelope; the MCP adapter may embed image content from those files. Clean temporary inputs without deleting returned artifacts prematurely.

### 4.3 Single Gemini media pipeline

All Gemini-backed tools will use one shared media-file service:

1. Validate the schema and resolve the input to a local file.
2. Determine and validate its MIME type and size.
3. Reuse a still-active uploaded file when a valid cache entry exists.
4. Otherwise upload once and poll until `ACTIVE`, with bounded timeout/backoff.
5. Fail clearly on `FAILED`, expired, malformed, or timed-out uploads.
6. Call Gemini with the file URI, MIME type, and a tool-specific prompt.
7. Return concise MCP text content and clean up local temporary artifacts.

There is no alternative-provider attempt after a Gemini error. Retry only transient operations where retrying is safe and bounded; do not hide persistent errors behind a fallback notice.

### 4.4 Native audio/video behavior

- Analyze and summarize the original video so Gemini can use visual and audio information together.
- Transcribe through the same upload service; avoid a separate audio provider abstraction.
- Do not transcribe separately and inject a transcript into Gemini video prompts.
- Start transcription with plain-text output. Gemini does not provide the same guaranteed diarization or machine-readable word timings as dedicated transcription services.
- Do not fabricate speaker labels, SRT/VTT timestamps, or confidence values. Add those formats only if a verified Gemini response contract supports them reliably.
- Timestamp-search results are model estimates, not frame-accurate seek positions; prompts and responses must say so when relevant.

### 4.5 Input handling and security

- Accept local paths, `file://` URIs, direct HTTP(S) media URLs, and yt-dlp-supported platform URLs.
- Normalize Windows paths and URIs correctly; verify that local inputs are readable files of supported media types.
- Invoke ffmpeg and yt-dlp with argument arrays, never shell-concatenated commands.
- Apply download byte limits, timeouts, redirect limits, and content-type checks.
- Defend against SSRF: resolve DNS and reject loopback, private, link-local, multicast, and metadata-service destinations, including after redirects and DNS changes. Document an explicit opt-in only if private-network media is later required.
- Keep downloaded files in per-request temporary directories and remove them on success and failure.
- Never log API keys, cookies, signed URL query strings, or media contents. Keep stdout reserved for MCP; diagnostics go to stderr or MCP logging.
- Bound frame counts in normal requests, image response sizes, pagination, concurrency, and subprocess execution time. Uncapped mode removes the license ceiling, not basic resource safety.
- Treat Skill instructions as workflow guidance, not a security boundary. The core/CLI must enforce validation, path safety, and resource limits even when invoked outside MCP.
- Do not interpolate untrusted media paths, URLs, questions, or model responses into shell commands. Use the typed CLI and argument arrays throughout.

### 4.6 Agent Skill package

Provide a redistributable Skill named `video-analyzer`:

```text
skills/video-analyzer/
  SKILL.md
  references/
    operations.md
    configuration.md
    troubleshooting.md
  scripts/
    invoke.mjs               Locates the CLI and forwards JSON safely
```

- `SKILL.md` uses valid frontmatter (`name: video-analyzer`, a keyword-rich description covering video analysis, summaries, transcription, timestamp search, metadata, and frame extraction).
- Keep the main instructions below 500 lines and progressively load detailed operation references only when needed.
- Include explicit operation-selection rules and examples: question → `analyze_video`, overview → `summarize_video`, exact event time → `search_timestamp`, speech → `transcribe_video`, technical details → `get_video_info`, images → `extract_frames`.
- Instruct the agent to run the packaged launcher without a shell, pass structured JSON, inspect the response envelope, and report warnings/uncertainty rather than inventing results.
- The launcher resolves an explicitly configured CLI or the package's installed runtime and fails with actionable setup guidance when Node.js, FFmpeg, yt-dlp, or the Gemini key is missing. It must not silently download executables or dependencies.
- Publish a portable Skill archive/directory for `.github/skills/video-analyzer/` (project) or `~/.copilot/skills/video-analyzer/` (personal). Avoid duplicating Skill copies across `.agents`, `.claude`, and other locations unless packaging for those clients is explicitly requested.
- Version the Skill and core together and verify their contract in CI. A Skill invocation must never require MCP installation, MCP configuration, or a running server.

### 4.7 Minimal caching

Use a small Gemini file-reference cache, not the reference project's full artifact-cache subsystem:

- Key local entries by canonical path plus file size/mtime (or a content hash if profiling justifies it).
- Coalesce concurrent uploads of the same source.
- Store only the Gemini file name/reference and essential metadata; verify `ACTIVE` before reuse.
- Respect Gemini's actual file-expiration contract and evict stale entries.
- Use an in-memory bounded LRU for the first version. Add persistence only if repeated-process performance demonstrates a need.
- Do not cache AI answers; different questions and prompts must remain independent.

### 4.8 Configuration

Keep only relevant environment variables:

| Variable                            | Purpose                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY`                    | Required only for Gemini-backed operations.                                                                                                            |
| `GEMINI_MODEL`                      | Optional model override; validated and resolved in one module.                                                                                         |
| `VIDEO_ANALYZER_MAX_FRAMES`         | Optional frame-sampling limit; default 100. `0` removes the configured ceiling, but a 500-frame hard cap per extraction still bounds `extract_frames`. |
| `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`    | Safety limit for remote downloads.                                                                                                                     |
| `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS` | AI request timeout.                                                                                                                                    |
| `YT_DLP_PATH`                       | Optional yt-dlp executable override.                                                                                                                   |
| `YT_DLP_MAX_RESOLUTION`             | Optional user-selected resolution limit, with no license enforcement.                                                                                  |
| `YT_DLP_COOKIES_FILE`               | Optional cookies file for authorized/private sources.                                                                                                  |
| `YT_DLP_IMPERSONATE`                | Optional yt-dlp impersonation setting.                                                                                                                 |
| `VIDEO_ANALYZER_CLI_PATH`           | Optional explicit core CLI path used by the Skill launcher.                                                                                            |

MCP environment configuration and Skill/CLI process environment use the same variable names and parsing module. Local-only operations should still run when `GEMINI_API_KEY` is absent. Gemini-backed calls should return an actionable configuration error rather than attempting another provider.

## 5. Proposed Project Layout

```text
src/
  cli.ts                    Standalone CLI used by the Skill and direct users
  mcp.ts                    Optional MCP stdio entry point
  config.ts                 Shared environment parsing and defaults
  operations/
    registry.ts             Names, descriptions, schemas, and handlers
    types.ts                Interface-neutral inputs and result envelopes
    analyzeVideo.ts
    summarizeVideo.ts
    searchTimestamp.ts
    transcribeVideo.ts
    getVideoInfo.ts
    extractFrames.ts
  adapters/
    mcp.ts                  Registry-to-MCP registration/content mapping
    cli.ts                  JSON parsing and stable CLI response mapping
  services/
    geminiClient.ts         Thin SDK wrapper
    geminiMedia.ts          Shared upload, poll, reuse, and inference flow
    mediaInput.ts           Local/URL/platform resolution and validation
    ffmpeg.ts               Metadata and frame extraction
    fileCache.ts            Bounded Gemini file-reference cache
  utils/
    errors.ts               Safe, actionable interface-neutral errors
    logger.ts               stderr/MCP logging without secrets
    tempFiles.ts            Temporary-directory and returned-artifact lifecycle
skills/
  video-analyzer/
    SKILL.md                On-demand procedure and operation-selection guidance
    references/             Detailed contracts loaded only when needed
    scripts/invoke.mjs       Safe launcher for the shared CLI
tests/
  unit/
  integration/
  contract/                 Same-operation CLI/MCP parity checks
  skill/                    Discovery, launcher, and end-to-end Skill fixtures
  live/                     Opt-in; never runs without explicit credentials
```

This layout is illustrative, not a request to create these files now. Avoid introducing provider interfaces or a generic orchestrator until a second provider is actually approved. Keep core services independent of both adapters and Skill content.

## 6. Implementation Sequence

### Phase 1 — Foundation and interface contracts

- Confirm the reusable-source license/attribution requirements and record the upstream revision used.
- Scaffold TypeScript, configuration, logging, safe errors, and the interface-neutral operation registry.
- Implement the standalone JSON CLI and MCP adapter against the same registry; neither adapter owns business logic.
- Establish build, type-check, lint, format, test, and Skill-package validation commands.
- Add a small deterministic media fixture for local integration tests.
- Define CLI envelopes, artifact behavior, and MCP content mapping before implementing operations.

**Exit:** MCP discovery and CLI help expose no operations beyond the approved analysis set; both adapters use one registry and local commands pass on Windows.

### Phase 2 — Media input and local tools

- Implement local/file URI/direct URL/platform resolution, validation, resource limits, and cleanup.
- Add metadata and paginated frame extraction with ffmpeg/ffprobe.
- Add yt-dlp resolution without Pro gates or resolution restrictions.

**Exit:** Metadata and frame tools work without a Gemini key, including Windows paths and failure cleanup.

### Phase 3 — Shared Gemini service

- Implement upload, bounded `ACTIVE` polling, model selection, native file prompting, safe errors, and file-reference reuse.
- Unit-test SDK request shapes, MIME propagation, processing failures, timeout behavior, expiry, and concurrent upload coalescing.

**Exit:** One reusable service handles all Gemini media operations; no tool contains its own upload/poll loop.

### Phase 4 — Core AI analysis tools

- Build question answering, summary, and timestamp-search prompts on the shared service.
- Remove provider options and all frame-based long-video/provider fallback paths.
- Return model uncertainty honestly and avoid unsupported structured timestamp claims.

**Exit:** Each tool handles native video/audio through Gemini and never imports another provider or licensing module.

### Phase 5 — Gemini transcription

- Add transcription using the shared native upload path.
- Support language/translation instructions where verified.
- Document plain-text limitations; reject unsupported diarization/subtitle options rather than silently pretending to support them.

**Exit:** Transcription works for both audio-bearing video and supported audio files, with no audio-provider router or prompt-injection path.

### Phase 6 — Agent Skill

- Author the `video-analyzer` Skill with discoverable frontmatter, concise selection guidance, and progressive operation references.
- Implement and test the safe CLI launcher, runtime discovery, JSON forwarding, error handling, and returned-artifact handling.
- Package project-level and personal installation options; document that the Skill and MCP are alternatives, not layers.
- Add contract tests proving Skill-selected CLI calls and MCP calls execute the same registered handlers.

**Exit:** A Skill-only installation can perform every approved operation with no MCP configuration or running MCP server, and returned artifacts remain usable.

### Phase 7 — Verification and documentation

- Complete unit, integration, CLI, MCP protocol, Skill, parity, and opt-in live Gemini tests.
- Document separate **Use as MCP** and **Use as Skill** setup paths, shared prerequisites, all operation contracts, quotas, privacy, and model limitations.
- Audit dependencies, imports, logs, environment variables, discovered tools, CLI help, and Skill guidance for excluded providers, generation, and licensing.

**Exit:** All acceptance criteria below pass and the documentation matches actual behavior in both modes.

## 7. Test and Acceptance Checklist

### Automated coverage

- Schema boundaries, path/URI normalization, MIME detection, URL/SSRF rejection, and environment parsing.
- Gemini upload → poll → prompt contracts using mocked SDK responses.
- Immediate `ACTIVE`, delayed `ACTIVE`, `FAILED`, timeout, expired cache, and concurrent-call cases.
- Temporary-file cleanup after success, API failure, subprocess failure, and invalid input.
- ffmpeg argument construction, frame pagination, and metadata parsing.
- MCP stdio smoke test covering tool discovery and representative calls.
- CLI contract tests for JSON input, stdout/stderr separation, exit codes, Windows paths, artifact survival, and machine-readable errors.
- Skill frontmatter/discovery, launcher safety, operation-selection fixtures, and a Skill-only end-to-end run with MCP unavailable.
- Parity tests asserting that CLI and MCP registration use identical operation names, schemas, handlers, and warnings.

### Final acceptance

- Exactly the six approved operations are discoverable through MCP, CLI, and Skill guidance; no generation operations are present.
- The project can be used **either as MCP or as a Skill**, with no requirement to install/configure the other interface.
- Both interfaces invoke the same core handlers; Skill operation instructions do not duplicate implementation logic.
- Every AI operation uses Gemini; no alternate provider package, key, parameter, or fallback exists.
- No license key, Pro check, payment service, feature-tier notice, or licensing backend exists.
- Platform and resolution behavior has no artificial license restriction.
- Video analysis and transcription share one native Gemini media path.
- Local metadata/frame operations work without an API key through either interface.
- No media-generation capability can be reached through a hidden generic endpoint.
- Temporary files and secrets are handled safely on Windows, and returned Skill/CLI artifacts are not prematurely deleted.
- Build, type-check, lint, unit tests, integration tests, CLI/MCP parity tests, Skill tests, and MCP smoke tests pass; live tests are explicitly opt-in.

## 8. Main Trade-offs

- **No provider fallback:** Gemini outages or quota exhaustion produce direct errors. This is intentional simplification.
- **Native Gemini sampling:** Fast visual events and exact timestamps may be missed. Frame extraction remains available for targeted inspection.
- **Transcription fidelity:** Gemini-only transcription may not match dedicated services for diarization or word-level timestamps.
- **Unlocked resources:** Removing artificial caps increases possible download size, API cost, memory use, and latency; configurable safety limits remain necessary.
- **Sensitive uploads:** AI-assisted analysis sends media to Google. This must be explicit in tool descriptions and documentation.

## 9. Planning Boundary

This document is the complete current plan. No source scaffolding, dependency installation, SDK integration, or feature implementation should occur until implementation is explicitly requested.
