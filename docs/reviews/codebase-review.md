# Codebase Review

**Date:** 2026-11-11  
**Scope:** Shared operations, media input and output, Gemini integration, CLI/MCP adapters, and relevant tests. Findings are ordered by severity. Line links refer to the current working tree.

## Findings

### P1: Platform downloads bypass the network security boundary (resolved)

Tracking issue: [#1](https://github.com/tugudush/video-analyzer/issues/1) (closed)

**Status:** Resolved. Known platform URLs and the `yt-dlp` fallback are no longer used. `resolveMediaInput` accepts only local paths and direct `http(s)` URLs, and `downloadToFile` checks every hop, including redirects, with `assertSafeHttpUrl`. Platform URLs are rejected, so `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` cannot enable them. Regression coverage is in `tests/unit/mediaInput.test.ts` and `tests/unit/net.test.ts`.

The original finding is kept below for reference.

[`resolveMediaInput`](../../src/services/mediaInput.ts) sends known platform URLs directly to `yt-dlp`, while [`resolveDirect`](../../src/services/mediaInput.ts) falls back to it after receiving a non-media response. Neither path applies the direct downloader's per-hop URL and DNS checks to the requests, redirects, or extracted media URLs made by `yt-dlp`. Consequently, private-network and credential-bearing destinations can be contacted even when `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` is false. A credential-bearing YouTube URL reached the configured downloader in a local probe instead of being rejected. This is separate from the documented DNS-rebinding limitation of the direct downloader.

Enforce the same destination policy for all downloader requests, including extractor-discovered URLs and redirects, or isolate/disable platform downloads when that policy cannot be enforced. Add tests for platform and HTML-fallback redirects to private destinations and credential-bearing URLs.

### P1: A transcript can overwrite the source media

Tracking issue: [#4](https://github.com/tugudush/video-analyzer/issues/4)

**Status:** Resolved. [`transcribe_video`](../../src/operations/transcribeVideo.ts) validates the output target before any upload or generation: [`isSameFile`](../../src/utils/fsUtils.ts) compares canonical paths (relative segments, symlinks, platform spelling) and device/inode pairs (hard links), so an `outputPath` that resolves to the source media is rejected with `INVALID_INPUT`. Existing files are only replaced when the new `overwrite: true` input is set, and the write itself uses an exclusive-create flag, so a file that appears after validation still fails instead of being clobbered. A directory target is rejected too. Regression coverage in `tests/unit/transcribeVideo.test.ts` and `tests/unit/fsUtils.test.ts` asserts the source bytes are unchanged.

The original finding is kept below for reference.

[`transcribe_video`](../../src/operations/transcribeVideo.ts) writes the transcript directly to the supplied `outputPath` without checking whether it refers to the source file. For example, using the same `.mp4` path for `videoPath` and `outputPath` truncates the original video after Gemini returns a transcript.

Reject source/output aliases before starting the upload, including resolved paths and filesystem aliases where applicable, and use an explicit overwrite policy for existing files. Add a regression test that verifies the original bytes remain unchanged.

### P2: Platform downloads and interval extraction lack effective size bounds

Tracking issue: [#10](https://github.com/tugudush/video-analyzer/issues/10)

The configured download byte limit is passed only to [`downloadToFile`](../../src/services/mediaInput.ts); [`runYtDlp`](../../src/services/mediaInput.ts) has no equivalent size limit, so a platform download can fill the disk before the 15-minute timeout. Separately, [`extractFramesAtInterval`](../../src/services/ffmpeg.ts) writes every frame before pagination, and `intervalSec` has no lower bound or extraction budget. A small positive interval on a long video can create a very large number of files despite `maxImages` and the configured frame limit.

Enforce storage and frame budgets during production, not just when constructing the response. Test oversized platform downloads and long or high-rate interval extraction with small configured limits.

### P2: Gemini timeout and cancellation are not enforced end to end

Tracking issue: [#11](https://github.com/tugudush/video-analyzer/issues/11)

The configured `requestTimeoutMs` is not used by the Gemini service. [`GoogleGenAiApi.generateContent`](../../src/services/gemini.ts) accepts a signal but does not pass it to the SDK; upload and status requests similarly receive no signal. The upload deadline in [`waitForActive`](../../src/services/gemini.ts) starts only after upload completes and cannot interrupt a stalled status request. A local probe with an already-aborted signal and a pending fake API call remained pending.

Apply bounded timeouts and cancellation to upload, polling, and generation, including individual network calls and waits, and propagate MCP cancellation where available. Test stalled and aborted calls rather than only immediately resolving fake APIs.

### P2: Reusing a frame output directory returns stale files

Tracking issue: [#12](https://github.com/tugudush/video-analyzer/issues/12)

[`listFrames`](../../src/services/ffmpeg.ts) returns every `.jpg` already in the output directory after an even or interval extraction. If a directory previously held more frames, a later extraction overwrites only the new numbered files and returns old frames as if they belonged to the new input; unrelated JPEGs are included too. Pagination and `totalFrames` then describe a mixed set, and the same output names overwrite existing files.

Isolate each extraction or explicitly track only files created by the current invocation, with a clear overwrite policy. Test repeated extractions into one directory with different inputs and counts.

### P2: Transcript output does not create the documented parent directory

Tracking issue: [#13](https://github.com/tugudush/video-analyzer/issues/13)

**Status:** Resolved. [`resolveTranscriptTarget`](../../src/operations/transcribeVideo.ts) now creates missing parent directories, and the whole target check (alias, existing file, directory) runs before the upload. The alias/overwrite work landed with [#15](https://github.com/tugudush/video-analyzer/pull/15); `tests/unit/transcribeVideo.test.ts` covers a nested new output directory.

The original finding is kept below for reference.

The [`outputPath` schema](../../src/operations/transcribeVideo.ts) promises that parent directories are created, but the operation calls `writeFile` directly. A valid path under a new directory fails after the Gemini upload and generation have completed.

Create the parent directory and validate the output target before the expensive request. Cover a nested new output directory in a transcription test.

## Verification And Gaps

- `npm test`: 110 passed, 15 skipped. FFmpeg and ffprobe were unavailable, so all 14 local-media integration tests and one MCP integration test were skipped.
- `npm run typecheck`: passed.
- Focused probes confirmed the platform URL validation bypass and lack of effective cancellation for a pending fake Gemini request. Other findings are based on source and test inspection; rendered-pixel behavior and live Gemini/yt-dlp interactions were not exercised in this environment.
- Priority assumes callers may supply untrusted media URLs. Restricting inputs to trusted users reduces the exposure of the network and resource-exhaustion findings, but does not correct the behavior.
