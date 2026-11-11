# Codebase Review

**Date:** 2026-11-11  
**Scope:** Shared operations, media input and output, Gemini integration, CLI/MCP adapters, and relevant tests. Findings are ordered by severity. Line links refer to the current working tree.

## Findings

### P1: Platform downloads bypass the network security boundary

[`resolveMediaInput`](../../src/services/mediaInput.ts#L295) sends known platform URLs directly to `yt-dlp`, while [`resolveDirect`](../../src/services/mediaInput.ts#L237) falls back to it after receiving a non-media response. Neither path applies the direct downloader's per-hop URL and DNS checks to the requests, redirects, or extracted media URLs made by `yt-dlp`. Consequently, private-network and credential-bearing destinations can be contacted even when `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` is false. A credential-bearing YouTube URL reached the configured downloader in a local probe instead of being rejected. This is separate from the documented DNS-rebinding limitation of the direct downloader.

Enforce the same destination policy for all downloader requests, including extractor-discovered URLs and redirects, or isolate/disable platform downloads when that policy cannot be enforced. Add tests for platform and HTML-fallback redirects to private destinations and credential-bearing URLs.

### P1: Start-only redaction windows do not cover the rest of the video

[`enableClause`](../../src/services/ffmpeg.ts#L352) sets the end time to the start time when a region has `startTime` but no `endTime`. The resulting `between(t,start,start)` applies at most at one instant, although the schema describes `startTime` as the start of the redaction window. A caller asking to hide a secret from a given time onward can receive an apparently successful output with the secret still visible.

Use an open-ended expression for start-only windows, and test rendered frames before and after the boundary for all effects. The current integration test only supplies both endpoints and checks that an output file exists.

### P1: Redaction shrinks odd-sized regions

[`renderRedactedVideo`](../../src/services/ffmpeg.ts#L383) rounds every width and height down to an even value, including blackout regions. A requested 101-by-51 region is therefore rendered as 100-by-50, leaving the rightmost column and bottom row outside the requested protection. The preview uses the original rounded dimensions, so it can also imply greater coverage than the rendered video.

Preserve or conservatively expand the requested bounds, accounting for FFmpeg's pixel-format alignment and frame edges. Add pixel-level tests for odd coordinates and dimensions for each effect, and compare the preview with the rendered result.

### P1: A transcript can overwrite the source media

[`transcribe_video`](../../src/operations/transcribeVideo.ts#L100) writes the transcript directly to the supplied `outputPath` without checking whether it refers to the source file. For example, using the same `.mp4` path for `videoPath` and `outputPath` truncates the original video after Gemini returns a transcript. Manual redaction already rejects a direct source/output collision.

Reject source/output aliases before starting the upload, including resolved paths and filesystem aliases where applicable, and use an explicit overwrite policy for existing files. Add a regression test that verifies the original bytes remain unchanged.

### P2: Consented AI-assisted redaction cannot create its sample frames

[`redact_sensitive`](../../src/operations/redactSensitive.ts#L238) passes a `samples` subdirectory of a new temporary directory to `extractFramesEvenly`, but never creates that subdirectory. The extraction helper writes directly into the supplied directory and does not create it, so FFmpeg fails before Gemini detection runs. The integration suite tests the consent rejection but not the consented AI path.

Create the sample directory before extraction and add an integration test using a fake Gemini service and real FFmpeg, covering both detections and empty results.

### P2: Platform downloads and interval extraction lack effective size bounds

The configured download byte limit is passed only to [`downloadToFile`](../../src/services/mediaInput.ts#L225); [`runYtDlp`](../../src/services/mediaInput.ts#L129) has no equivalent size limit, so a platform download can fill the disk before the 15-minute timeout. Separately, [`extractFramesAtInterval`](../../src/services/ffmpeg.ts#L212) writes every frame before pagination, and `intervalSec` has no lower bound or extraction budget. A small positive interval on a long video can create a very large number of files despite `maxImages` and the configured frame limit.

Enforce storage and frame budgets during production, not just when constructing the response. Test oversized platform downloads and long or high-rate interval extraction with small configured limits.

### P2: Gemini timeout and cancellation are not enforced end to end

The configured `requestTimeoutMs` is not used by the Gemini service. [`GoogleGenAiApi.generateContent`](../../src/services/gemini.ts#L76) accepts a signal but does not pass it to the SDK; upload and status requests similarly receive no signal. The upload deadline in [`waitForActive`](../../src/services/gemini.ts#L274) starts only after upload completes and cannot interrupt a stalled status request. A local probe with an already-aborted signal and a pending fake API call remained pending.

Apply bounded timeouts and cancellation to upload, polling, and generation, including individual network calls and waits, and propagate MCP cancellation where available. Test stalled and aborted calls rather than only immediately resolving fake APIs.

### P2: Reusing a frame output directory returns stale files

[`listFrames`](../../src/services/ffmpeg.ts#L163) returns every `.jpg` already in the output directory after an even or interval extraction. If a directory previously held more frames, a later extraction overwrites only the new numbered files and returns old frames as if they belonged to the new input; unrelated JPEGs are included too. Pagination and `totalFrames` then describe a mixed set, and the same output names overwrite existing files.

Isolate each extraction or explicitly track only files created by the current invocation, with a clear overwrite policy. Test repeated extractions into one directory with different inputs and counts.

### P2: Transcript output does not create the documented parent directory

The [`outputPath` schema](../../src/operations/transcribeVideo.ts#L25) promises that parent directories are created, but the operation calls `writeFile` directly. A valid path under a new directory fails after the Gemini upload and generation have completed.

Create the parent directory and validate the output target before the expensive request. Cover a nested new output directory in a transcription test.

## Verification And Gaps

- `npm test`: 110 passed, 15 skipped. FFmpeg and ffprobe were unavailable, so all 14 local-media integration tests and one MCP integration test were skipped.
- `npm run typecheck`: passed.
- Focused probes confirmed the platform URL validation bypass and lack of effective cancellation for a pending fake Gemini request. Other findings are based on source and test inspection; rendered-pixel behavior and live Gemini/yt-dlp interactions were not exercised in this environment.
- Priority assumes callers may supply untrusted media URLs and rely on redacted artifacts before sharing them. Restricting inputs to trusted users reduces the exposure of the network and resource-exhaustion findings, but does not correct the behavior.
