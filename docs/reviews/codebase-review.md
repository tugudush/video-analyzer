# Codebase Review

**Date:** 2026-11-11
**Revision:** `12d2c45` (working tree, `docs/reviews` changes excluded)
**Scope:** all of `src/`, `tests/`, `skills/`, and the user-facing docs, plus the build/lint/test configuration.

## Method

- Read every source file under [`src/`](../../src), the six operations, both adapters, the Gemini/FFmpeg services, the network and filesystem helpers, all tests, and the README plus the three Skill reference documents.
- Ran the full gate: `npm run check` (typecheck → oxlint → vitest → prettier). **Result: green** — `tsc --noEmit` clean, oxlint clean, **172 tests passed / 1 skipped** across 17 files in ~6.6 s, Prettier clean.
- Reproduced two runtime behaviours against the built CLI and a locally generated FFmpeg fixture (details in the findings below), and inspected the artifacts each run leaves behind.

Overall this is a well-structured, unusually well-documented codebase. Layering is clean (registry → operations → services → utils, with thin adapters), the error model is uniform, security-sensitive paths are deliberately hardened, and the test suite is fast and behaviour-oriented. The findings below are mostly contract, hygiene, and edge-case issues; **no P1 defect was found**.

## Findings Summary

| #   | Severity | Area             | Finding                                                                                                                                                              |
| --- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2       | Error contract   | A transcript write failure reports `INTERNAL`; `OUTPUT_FAILED` is declared and documented but never thrown                                                           |
| 2   | P2       | Ordering / cost  | A remote input is fully downloaded before the missing `GEMINI_API_KEY` is reported                                                                                   |
| 3   | P2       | Input validation | `extract_frames` (timestamps mode) does not bound timestamps to the media duration; one out-of-range value fails the whole request and leaves partial frames on disk |
| 4   | P3       | Formatting       | `formatTimestamp` can render a `.1000` milliseconds field                                                                                                            |
| 5   | P3       | Repo hygiene     | `video-analyzer-output/` (the default artifact root) is not in `.gitignore`                                                                                          |
| 6   | P3       | Consistency      | Scene mode skips the audio-only guard that the other frame modes apply                                                                                               |
| 7   | P3       | Cleanup          | Only the MCP adapter sweeps stale temp directories; the CLI never does                                                                                               |
| 8   | P3       | Maintainability  | Dead code and a stale configuration surface (`yt-dlp` settings, unused helpers/exports)                                                                              |
| 9   | P3       | API surface      | `executeOperation` is exported but performs no schema validation                                                                                                     |
| 10  | P3       | Accuracy         | Interval-mode timestamps are derived from the frame index, not from the frames actually written                                                                      |
| 11  | P3       | Docs             | `.env.example` omits four settings the README and `configuration.md` document                                                                                        |
| 12  | P3       | Docs             | `maxFrames` is documented as a budget for "AI-assisted sampling", which does not exist                                                                               |
| 13  | P3       | MCP contract     | Tools advertise `destructiveHint: false` while `transcribe_video` can replace any existing file via `overwrite`                                                      |
| 14  | P3       | Robustness       | `readStdin` has no timeout and can block on an inherited, open non-TTY stdin                                                                                         |
| 15  | P3       | Versioning       | `SERVER_VERSION` is a hard-coded copy of `package.json`'s version                                                                                                    |

## Findings

### P2: A transcript write failure reports `INTERNAL`, not `OUTPUT_FAILED`

**Where:** [`writeTranscript`](../../src/operations/transcribeVideo.ts:145), [`ERROR_CODES`](../../src/utils/errors.ts:22), comment at [`transcribeVideo.ts:81`](../../src/operations/transcribeVideo.ts:81).

`OUTPUT_FAILED` is declared in the error union, listed in the README error table, and the comment above `writeTranscript` explicitly promises it is "reserved for failures while writing, which `writeTranscript` surfaces unchanged". In practice `writeTranscript` re-throws every write error except `EEXIST`/`EISDIR`, so `ENOSPC`, `EACCES`, `EPERM`, and `EROFS` all reach [`toVideoAnalyzerError`](../../src/utils/errors.ts:64) and become `INTERNAL` with a bare OS message.

**Impact:** the documented error contract is wrong for the one failure mode it names, `INTERNAL` reads like a bug in the tool rather than a caller-environment problem, and there is no hint telling the user that the transcript text was produced and only the file write failed.

**Suggested fix:** wrap the non-`EEXIST`/`EISDIR` branch in a `VideoAnalyzerError('OUTPUT_FAILED', …)` that keeps the target path in `details` and adds the hint "The transcript was generated; choose a writable path or free disk space." Add a unit test that makes the write fail (read-only directory or a mocked `writeFile`).

### P2: A remote input is fully downloaded before the missing `GEMINI_API_KEY` is reported

**Where:** [`analyzeVideo.ts:25`](../../src/operations/analyzeVideo.ts:25), [`summarizeVideo.ts`](../../src/operations/summarizeVideo.ts), [`searchTimestamp.ts`](../../src/operations/searchTimestamp.ts), [`transcribeVideo.ts`](../../src/operations/transcribeVideo.ts).

Every Gemini-backed operation calls `prepareMedia()` first and only then `getGeminiService()`, which is the sole place `requireGeminiApiKey` runs ([`gemini.ts:158`](../../src/services/gemini.ts:158)). For a direct HTTP(S) input, `prepareMedia` → `resolveMediaInput` → `resolveDirect` downloads the whole file (up to `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`, default 2 GB) and runs `ffprobe` before `CONFIG_MISSING` is raised.

**Impact:** an unconfigured user or MCP client waits through a large download to learn the key is absent, and the error arrives after the most expensive part of the call. This is a common first-run scenario (the documented fix is a one-line env var).

**Suggested fix:** assert the provider requirement before resolving media — e.g. `if (operation.requiresGemini) requireGeminiApiKey(ctx.config)` at the top of `run`, or a shared `prepareGeminiOperation()` helper that checks configuration first. Note `transcribeVideo` already validates its `outputPath` before touching media, so the ordering precedent exists.

### P2: `extract_frames` timestamps mode does not bound timestamps to the media duration

**Where:** [`extractFrames.ts:160`](../../src/operations/extractFrames.ts:160), [`extractFramesAtTimestamps`](../../src/services/ffmpeg.ts:382), [`results.push(target)`](../../src/services/ffmpeg.ts:414).

The operation already knows `prepared.metadata.durationSeconds`, but the timestamps are passed straight to FFmpeg. Reproduced on this machine with a 2 s fixture:

```text
video-analyzer extract_frames --input '{"videoPath":"sample2.mp4","mode":"timestamps","timestamps":[0.5,999]}'
→ {"ok":false,"error":{"code":"MEDIA_PROCESSING_FAILED","message":"ffmpeg failed.",
   "hint":"…[out#0/image2] Nothing was written into output file, because at least one of its streams received no packets."}}
```

Two distinct problems follow from this:

1. **The error is unattributable.** The user is told "ffmpeg failed" with a raw encoder log; nothing identifies `999` as the offending timestamp or that the clip is only 2 s long. A single bad value also discards the frames that other timestamps produced.
2. **Partial artifacts are left on disk.** `frame-0001.jpg` (from the valid `0.5` timestamp) survives in the freshly created artifact folder while the call reports failure, so the caller cannot tell which of the files are trustworthy.
3. **A phantom path is possible on other FFmpeg builds.** `results.push(target)` (line 414) never checks that the file exists. On builds that exit 0 without writing an output, `extract_frames` would return an `images[]` entry for a non-existent file, and [`loadImages`](../../src/adapters/envelope.ts:50) would then fail the MCP call with `INTERNAL ... ENOENT` after all the work was done.

**Suggested fix:** validate the array against `durationSeconds` before the first subprocess (`timestamp >= duration` → `INVALID_INPUT` naming the value and the duration), and `stat` each produced file so a missing output is reported per-timestamp rather than as a generic FFmpeg failure. Consider cleaning up the artifact directory when the extraction aborts so a failed call leaves nothing behind.

### P3: `formatTimestamp` can render a `.1000` milliseconds field

**Where:** [`shared.ts:100`](../../src/operations/shared.ts:100) (line 106).

`ms` is rounded independently of `total`, so any duration with a fractional part ≥ 0.9995 formats as `HH:MM:SS.1000`. Verified: `1.9996 → 00:00:01.1000`, `5.9999 → 00:00:05.1000`. The helper is used in `search_timestamp` summaries and in the `get_video_info` duration line, and FFprobe durations are frequently non-round.

**Suggested fix:** work in integer milliseconds (`const totalMs = Math.round(seconds * 1000)` and derive hours/minutes/seconds/ms from that), and add the two boundary cases to [`shared.test.ts`](../../tests/unit/shared.test.ts).

### P3: `video-analyzer-output/` is not in `.gitignore`

**Where:** [`.gitignore`](../../.gitignore), [`createArtifactDir`](../../src/operations/shared.ts:81), [`.oxlintrc.json`](../../.oxlintrc.json).

Artifacts default to `./video-analyzer-output/frames-<stamp>-<id>/`, i.e. inside whatever repository the tool runs in. `.oxlintrc.json` already ignores `video-analyzer-output/**`, but `.gitignore` does not, so the first `extract_frames` run in a consumer repo (or in this one — the reproduction above left an untracked `video-analyzer-output/frames-…/frame-0001.jpg`) pollutes `git status`.

**Suggested fix:** add `video-analyzer-output/` to `.gitignore` (and mention the default artifact root in the README's Known Limitations, which currently only says frames "persist until you delete them").

### P3: Scene mode skips the audio-only guard that the other frame modes apply

**Where:** [`extractFrames.ts:106`](../../src/operations/extractFrames.ts:106).

```ts
if (mode !== 'scene' && !prepared.metadata.hasVideo) { … UNSUPPORTED_INPUT … }
```

Scene detection is the one mode where a missing video stream is _always_ fatal (the filter graph has no frames to select), yet it is the only mode allowed through the guard. An audio-only input reaches FFmpeg and fails as `MEDIA_PROCESSING_FAILED` instead of the actionable `UNSUPPORTED_INPUT` ("Use `transcribe_video` for audio-only files") that the other modes return — and `troubleshooting.md` promises that message for "[f]rame extraction on audio-only input".

**Suggested fix:** drop the `mode !== 'scene'` condition, or narrow it to the modes where audio-only could plausibly work (there are none).

### P3: Only the MCP adapter sweeps stale temp directories

**Where:** [`mcpServer.ts:88`](../../src/adapters/mcpServer.ts:88), [`sweepStaleTempDirs`](../../src/utils/fsUtils.ts:22).

`sweepStaleTempDirs()` runs once when the MCP server starts. The CLI path never calls it, so a CLI user whose process was killed mid-download accumulates `%TEMP%/video-analyzer-*` directories indefinitely — the exact failure the sweep exists to clean up, in the interface where it is never invoked.

**Suggested fix:** call the sweep (fire-and-forget) from `runCli` for long-lived-cost operations, or from `createTempDir` on a best-effort, once-per-process basis. Alternatively document that temp hygiene is MCP-only.

### P3: Dead code and a stale configuration surface

**Where:** [`src/utils/base64.ts`](../../src/utils/base64.ts), [`resolveOutputPath`](../../src/services/mediaInput.ts:172), [`VIDEO_EXTENSIONS`/`AUDIO_EXTENSIONS`](../../src/utils/mime.ts:34), [`extensionForMimeType`](../../src/utils/mime.ts:65), [`runCommand`](../../src/services/ffmpeg.ts:472), [`progress`](../../src/operations/types.ts:55), [`ytDlp*` in `Config`](../../src/config.ts:29).

- `bufferToBase64`/`fileToBase64` are never imported; [`envelope.ts`](../../src/adapters/envelope.ts:57) converts with `Buffer` directly.
- `resolveOutputPath`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`, `runCommand`, and `progress` have no non-test callers (some have none at all). `extensionForMimeType` is only exercised by its own test.
- `config.ytDlpPath`, `ytDlpMaxResolution`, `ytDlpCookiesFile`, `ytDlpImpersonate` are parsed from the environment on every startup but read nowhere. The docs call them legacy no-ops, and [`mediaInput.test.ts`](../../tests/unit/mediaInput.test.ts:22) deliberately sets `YT_DLP_PATH` to prove it is ignored — so the parsing is now only a compatibility shim.

**Impact:** each item is small, but together they invite the reader to reason about code paths that cannot run and make `tsc`/oxlint coverage of "is this used?" harder to trust.

**Suggested fix:** delete the unused helpers, or move `yt-dlp` parsing behind a single documented legacy block (with a comment stating _why_ it is retained) so the compatibility intent is explicit rather than implied by a comment in the docs.

### P3: `executeOperation` is exported but performs no schema validation

**Where:** [`execute.ts:20`](../../src/operations/execute.ts:20), [`index.ts`](../../src/index.ts).

Both adapters validate before calling (`operation.inputSchema.parse` in [`mcpTools.ts`](../../src/adapters/mcpTools.ts:81) and [`cli.ts`](../../src/adapters/cli.ts:237)), but `executeOperation` is part of the public embedding surface and accepts `unknown`, casting it with `input as never`. An embedder that follows the exported API gets unvalidated input, so a missing `videoPath` surfaces as `INTERNAL`/FFmpeg noise instead of `INVALID_INPUT`.

**Suggested fix:** parse inside `executeOperation` (and let the adapters rely on it), or rename the exported entry point to make the unchecked contract explicit and document the alternative.

### P3: Interval-mode timestamps are derived from the frame index, not from the frames actually written

**Where:** [`extractFrames.ts:145`](../../src/operations/extractFrames.ts:145).

`paths.forEach((_, index) => timestamps.push(index * intervalSec))` assumes FFmpeg's `fps=1/interval` pass emitted exactly one frame per interval starting at `t = 0`. With variable-frame-rate input, dropped frames, or the `-frames:v` cut, the label for frame _n_ can differ from the frame's real presentation time, and those labels are what `images[].label` (`t=…s`) and `data.timestamps` report.

**Suggested fix:** either label interval frames by their filename position and describe them as "sampled every `intervalSec`" rather than exact times, or parse `pts_time` (as scene mode already does with `showinfo`) so labels match the pixels returned. At minimum, note the approximation in `operations.md` the way timestamp estimates are already flagged.

### P3: `.env.example` omits four documented settings

**Where:** [`.env.example`](../../.env.example).

`VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`, `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, `VIDEO_ANALYZER_POLL_INTERVAL_MS`, and `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` are documented in the README and `configuration.md` but absent from the file users copy to start configuring. Given that the timeout settings are the primary remedy for `GEMINI_TIMEOUT`, that is the one place they should be discoverable.

**Suggested fix:** add commented entries with their defaults, matching the existing style.

### P3: `maxFrames` is documented as a budget for "AI-assisted sampling", which does not exist

**Where:** [`config.ts:18`](../../src/config.ts:18), README configuration table, `configuration.md` "Limits".

`VIDEO_ANALYZER_MAX_FRAMES` only affects `extract_frames` (`interval` mode) and the scene-mode ceiling. The four AI operations send the whole media file to Gemini; nothing in `src/` samples frames for the model. The `Config` comment ("Frame budget for AI-assisted sampling, scene detection, and `extract_frames` interval mode") and the README's "Frame budget for sampling and extraction" therefore describe a capability that is not implemented.

**Suggested fix:** describe the setting in terms of `extract_frames` only. Leaving the "AI sampling" claim in place invites users to expect a knob that changes Gemini behaviour.

### P3: Tools advertise `destructiveHint: false` while `overwrite` can replace any existing file

**Where:** [`mcpServer.ts:65`](../../src/adapters/mcpServer.ts:65), [`transcribeVideoInput.overwrite`](../../src/operations/transcribeVideo.ts:33).

`destructiveHint: false` is published for every tool. `transcribe_video` with `overwrite: true` will replace a file at any caller-chosen absolute path (the source-media aliasing check only protects the input file). Clients that gate or warn on destructive hints will therefore under-report the risk.

**Impact:** low in practice — the caller must opt in explicitly and the alias guard prevents the worst case — but the annotation is factually wrong for one documented input, and MCP annotations are the machine-readable safety contract.

**Suggested fix:** set `destructiveHint` per operation (derive from `requiresGemini` or add an explicit field), or keep `false` and document in `transcribeVideo.ts` that `overwrite` is deliberately not exposed as destructive because the target is caller-specified.

### P3: `readStdin` has no timeout and can block on an inherited, open non-TTY stdin

**Where:** [`cli.ts:35`](../../src/adapters/cli.ts:35).

`defaultCliIO.readStdin` drains stdin to EOF whenever `process.stdin.isTTY` is false. The Skill launcher spawns with `stdio: ['ignore', …]` so EOF is immediate, but any caller that spawns the CLI with an inherited pipe it does not close (some agent harnesses, `spawn` without `stdin: 'ignore'`, wrapper scripts that keep the pipe open) makes `video-analyzer get_video_info` hang before it reads `--input`.

**Suggested fix:** only fall back to stdin when no `--input`/`--input-file` was supplied _and_ wrap the read in a short timeout (or require an explicit `--stdin` flag), so an unrequested stdin can never block execution.

### P3: `SERVER_VERSION` is a hard-coded copy of `package.json`'s version

**Where:** [`mcpServer.ts:11`](../../src/adapters/mcpServer.ts:11).

`SERVER_VERSION = '0.1.0'` duplicates `package.json`. A version bump (or a `npm version` run) will silently leave MCP clients reporting the old version in `initialize`. There is also no `--version` flag on the CLI, so the only machine-readable version is this constant.

**Suggested fix:** read `version` from `package.json` at build time (e.g. `resolveJsonModule` import or `createRequire`), or generate a `version.ts` during build. Add `video-analyzer --version`.

## Architecture And Quality

**Strengths**

- **One source of truth per concern.** [`registry.ts`](../../src/operations/registry.ts) owns names, titles, schemas, and handlers; both adapters iterate it, and [`tests/contract/parity.test.ts`](../../tests/contract/parity.test.ts) enforces name/schema/description/read-only parity, including that the schema _object identity_ is shared. This is the right shape for a dual-interface tool.
- **Uniform error contract.** Every expected failure is a `VideoAnalyzerError` with a stable code, optional hint, and structured details; adapters render it consistently as JSON (CLI), text content (MCP), or an `ErrorEnvelope`. Stack traces and secrets never cross the boundary.
- **Deterministic, testable services.** `GeminiMediaService` takes an injectable `api`, `now`, and `sleep`; `runWithBounds` makes cancellation and deadlines testable without real timers; FFmpeg arguments are arrays through `execFile`, so there is no shell to inject into.
- **Storage invariants are explicit.** The "one artifact directory per request" rule is documented at the type ([`FrameExtractionOptions.outDir`](../../src/services/ffmpeg.ts:163)), enforced for the modes that list the directory, and covered by both unit and integration tests.
- **Strictness that pays off.** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `isolatedModules` are all on, and the code is written to satisfy them rather than casting around them.
- **Docs as part of the product.** README, `SKILL.md`, and the three reference docs agree with the code on nearly every detail (settings, error codes, exit behaviour, Windows quirks). The discrepancies in findings 11–12 are the exceptions.

**Weaknesses**

- **Module-level mutable singletons.** [`sharedService`](../../src/operations/shared.ts:15) and the logger [`sink`](../../src/utils/logger.ts:30) are process-global. `resetGeminiService()` and `setLogSink(undefined)` exist, but two embedded instances with different configs or sinks in one process would interfere. Acceptable for the CLI/MCP shapes shipped, worth documenting for embedders.
- **Retry policy is absent by design but undocumented.** A transient 5xx or DNS blip fails the operation; the only recovery guidance is "retry". Fine for a CLI, but MCP clients that auto-retry will re-upload media.
- **Timeout constants are not configurable.** `FFMPEG_TIMEOUT_MS` (10 min) and `FFPROBE_TIMEOUT_MS` (60 s) are hard-coded while Gemini deadlines are configurable. Scene detection over a feature-length file can hit the former with only a generic `MEDIA_PROCESSING_FAILED`.
- **`ensureDir` uses a dynamic import** ([`fsUtils.ts:49`](../../src/utils/fsUtils.ts:49)) while every other Node builtin is imported statically — a needless inconsistency in a hot path.

## Security Assessment

The network boundary is the strongest part of the codebase.

- **SSRF defence is layered.** [`assertSafeHttpUrl`](../../src/utils/net.ts:153) rejects non-HTTP(S) schemes, embedded credentials, blocked hostnames (localhost/cloud metadata), and any hostname that resolves to a private, loopback, link-local, CGNAT, documentation, or multicast range. IPv6 handling covers `::1`, `::`, ULA, link-local, multicast, and IPv4-mapped/NAT64 embeddings, and fails closed on unparseable addresses. Downloads revalidate **every redirect hop** with `redirect: 'manual'` ([`net.ts:247`](../../src/utils/net.ts:247)) rather than letting `fetch` follow blindly.
- **Known residual risk is documented honestly.** The resolve→connect window is not pinned, so DNS rebinding remains theoretically possible; the README says so instead of over-claiming.
- **Size and time bounds are enforced twice.** `Content-Length` is checked up front and the stream is counted as it is written, so a chunked response cannot exceed `maxBytes`.
- **Command execution is safe.** FFmpeg/FFprobe run via `execFile` with argument arrays; user input never reaches a shell. Local paths are resolved to absolute paths before use, so a `videoPath` beginning with `-` cannot be interpreted as an FFmpeg option.
- **Source-media protection is thorough** for `transcribe_video`: canonical-path comparison (covering `..`, symlinks, casing) plus device/inode comparison (covering hard links), validated before upload, and backed by an exclusive-create `wx` write so a target appearing after validation still cannot be clobbered.
- **No secrets are logged.** Diagnostics go to stderr or the MCP logging channel; the API key is only ever passed to the SDK.

**Remaining considerations, all by design but worth stating in the README:** AI operations upload user media to Google; `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` disables the whole SSRF layer for direct downloads; and `transcribe_video`/`extract_frames` write to caller-supplied paths, so the tool is only as trustworthy as the caller's path choice.

## Test Assessment

The suite (172 passing, 1 skipped, ~6.6 s) is the main reason the findings above are small: most invariants are pinned by tests.

| Area                         | Coverage | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini timeouts/cancellation | Strong   | Stalled generation, stalled status poll, stalled upload, pre-aborted caller, upload time counted against the processing deadline, signal + deadline handed to the SDK, MCP signal propagation into the context.                                                                                                                                                |
| Frame budgets                | Strong   | Budget passed to FFmpeg as `-frames:v`, on-disk count capped, uncapped config still bounded, paging does not change the produced count, sub-minimum interval rejected before any process runs.                                                                                                                                                                 |
| Output isolation             | Strong   | Reused directories report only their own frames; pre-populated directories are rejected without invoking FFmpeg; integration test reuses one output directory.                                                                                                                                                                                                 |
| Source overwrite protection  | Strong   | Relative-spelling alias, `file://` alias, symlink, hard link, existing file, directory target, exclusive-create race.                                                                                                                                                                                                                                          |
| SSRF / download policy       | Good     | Private/reserved ranges, IPv6 forms, credentials, platform-URL rejection, opt-in behaviour, mid-stream size limit.                                                                                                                                                                                                                                             |
| CLI/MCP parity               | Good     | Names, schema identity, descriptions, read-only classification, forbidden capability names.                                                                                                                                                                                                                                                                    |
| **Gaps**                     | —        | (a) no test for an out-of-range timestamp (finding 3); (b) no test asserting `OUTPUT_FAILED` (finding 1); (c) no test that a Gemini operation fails _before_ downloading (finding 2); (d) `formatTimestamp` boundaries (finding 4) are untested; (e) symlink/hard-link cases self-skip on platforms without the privilege, so Windows CI silently covers less. |

The integration and Skill suites skip themselves when FFmpeg is missing; the README already warns that a green run may mean those tests did not execute. Consider surfacing the skip count in CI output so a "green" run without FFmpeg is visibly different from a fully exercised one.

## Verification Performed

```text
npm run check
  typecheck  tsc -p tsconfig.json --noEmit           clean
  lint       oxlint src tests skills                 clean
  test       vitest run                              17 files, 172 passed, 1 skipped
  format     prettier --check .                      clean
```

Manual probes (built CLI, `dist/cli.js`, generated FFmpeg fixture):

- `extract_frames` with `timestamps: [0.5, 999]` on a 2 s clip → `MEDIA_PROCESSING_FAILED: ffmpeg failed.` with a raw encoder-log hint, and `video-analyzer-output/frames-…/frame-0001.jpg` left on disk (finding 3, finding 5).
- `formatTimestamp` arithmetic for `1.9996` and `5.9999` → `00:00:01.1000` / `00:00:05.1000` (finding 4).

## Resolution Status

All 15 findings were addressed on 2026-11-11. `npm run check` is green (typecheck, oxlint, 194 tests passed / 1 skipped, Prettier), and the P2 behaviours were re-probed against the built CLI.

| #   | Resolution                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `writeTranscript` wraps every non-`EEXIST`/`EISDIR` failure in `OUTPUT_FAILED` with the target path, the OS code, and the writable-path hint. Covered by `tests/unit/transcribeOutput.test.ts`.                                                       |
| 2   | New `assertGeminiAvailable` runs before `prepareMedia` in all four Gemini operations, so `CONFIG_MISSING` precedes any download. Covered by `tests/unit/geminiPreflight.test.ts`.                                                                     |
| 3   | `timestamps` mode rejects values at or beyond the media duration as `INVALID_INPUT` (naming the value and duration) before the first subprocess, `extractFramesAtTimestamps` stats every output, and a failed extraction removes its artifact folder. |
| 4   | `formatTimestamp` rounds once into integer milliseconds, so `.1000` can no longer appear. Boundary cases added to `shared.test.ts`.                                                                                                                   |
| 5   | `video-analyzer-output/` is in `.gitignore`, and the README's Known Limitations names the default artifact root.                                                                                                                                      |
| 6   | The audio-only guard now applies to every frame mode, including `scene`.                                                                                                                                                                              |
| 7   | `runCli` sweeps stale temp directories once per process (fire-and-forget), matching the MCP server.                                                                                                                                                   |
| 8   | Removed `src/utils/base64.ts`, `resolveOutputPath`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`, `extensionForMimeType`, `runCommand`, `progress`, and the `ytDlp*` configuration fields; the legacy `YT_DLP_*` variables are documented as unread.        |
| 9   | `executeOperation` validates against the operation's `inputSchema` (`parseOperationInput`), so embedders get `INVALID_INPUT` too.                                                                                                                     |
| 10  | `interval` mode parses `showinfo` `pts_time` values; labels and `data.timestamps` are the frames' real presentation times, with a documented fallback warning when a build reports none.                                                              |
| 11  | `.env.example` gained `VIDEO_ANALYZER_REQUEST_TIMEOUT_MS`, `VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS`, `VIDEO_ANALYZER_POLL_INTERVAL_MS`, and `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`.                                                                           |
| 12  | `maxFrames` is described as an `extract_frames`-only budget in the `Config` comment, README, and `configuration.md`.                                                                                                                                  |
| 13  | Operations declare `readOnly`/`destructive`; `transcribe_video` now publishes `destructiveHint: true` (and is no longer claimed read-only).                                                                                                           |
| 14  | The CLI reads stdin only when no `--input`/`--input-file` is supplied and gives up after 500 ms of silence, so an inherited open pipe cannot block it.                                                                                                |
| 15  | `SERVER_VERSION` is read from `package.json` via `src/version.ts`, and the CLI gained `--version`.                                                                                                                                                    |

## Recommended Order

> Historical: this ordering was the review's proposal and every item in it has since been completed (see Resolution Status above).

1. Findings 1–3 (error contract, configuration ordering, timestamp bounds) — all user-visible, each a small, testable change.
2. Finding 5 (`.gitignore`) and finding 11 (`.env.example`) — one-line hygiene fixes that stop the repo and its consumers from collecting noise.
3. Findings 4, 6, 12 — correctness/documentation drift with no design impact.
4. Finding 8 (dead code) — do it in one pass while the surface is small; it also removes the misleading `yt-dlp` configuration from `Config`.
5. Findings 7, 9, 10, 13–15 — consistency and robustness items; worth a tracking issue rather than a rush.
