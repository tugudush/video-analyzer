# Codebase Review

Reviewed: 2026-11-11

## Scope and assessment

Reviewed the current working tree across the CLI, MCP and Skill interfaces,
operation registry, media resolution, FFmpeg and Gemini services, filesystem
handling, and representative tests. This is a targeted codebase review, not an
exhaustive security audit or production load test.

The shared registry, strict input validation, explicit cancellation, bounded
downloads, and substantial unit and integration coverage are good foundations.
The review identified incorrect frame selection or labels, reuse of stale
uploaded media, and unbounded MCP image responses as the most important risks.

Priorities below describe impact and likelihood in normal use: P2 is a
correctness or reliability issue worth addressing; P3 is a narrower usability
or operational issue. The descriptions and evidence below refer to the code
as originally reviewed; remediation status is recorded with each finding.

## Findings

### [Resolved] P2 — Timestamp extraction can select the wrong frame or fail near the end

**Status: Resolved.** Labels identify requested times, every page warns that
they are not source presentation times, and an end-of-clip fallback returns
the final frame. Real-FFmpeg tests cover low frame rates and longer audio.

**Locations:** [ffmpeg.ts](../../src/services/ffmpeg.ts#L428),
[extractFrames.ts](../../src/operations/extractFrames.ts#L214),
[extractFrames.ts](../../src/operations/extractFrames.ts#L354).

The FFmpeg helper describes its result as the closest frame, but input seeking
with `-ss` discards frames before the requested position. The operation then
labels the result with the requested timestamp, not the selected frame's
presentation time. If the requested time is after the last frame's timestamp
but still inside the container duration, FFmpeg can produce no frame and fail
the entire request, including any earlier valid timestamps.

**Evidence:** With a generated two-second, 2 fps video, the frame returned for
`0.1` seconds had the same JPEG hash as the frame at `0.5`, not the frame at
`0`. A request for `1.9` seconds passed duration validation but failed with
`MEDIA_PROCESSING_FAILED`; `1.4` seconds succeeded. The existing
[integration test](../../tests/integration/localMedia.test.ts#L98) checks
returned request timestamps, not the selected source-frame identity or the
last-frame boundary.

**Recommendation:** Define whether timestamps mean nearest frame or first frame
at/after the time, implement that policy including the tail of the clip, and
return or clearly label actual versus requested times. Add real-FFmpeg tests
with distinguishable low-frame-rate frames and a timestamp after the last
frame but before the duration.

### [Resolved] P2 — Local upload cache can reuse media after its contents change

**Status: Resolved.** Local files without a stable content identity are uploaded
each time and are not coalesced. Direct downloads retain content-based reuse.

**Locations:** [gemini.ts](../../src/services/gemini.ts#L261),
[shared.ts](../../src/operations/shared.ts#L98).

Local upload identities use path, size, and modification time rounded to a
millisecond. Two different same-size revisions with mtimes in the same rounded
millisecond are treated as the same file. Preserved timestamps can produce the
same collision even without rounding. A still-active cached Gemini file is
then reused, so analysis or transcription can silently describe the previous
contents.

**Evidence:** In a local test with a fake Gemini API, a four-byte file was
changed from `AAAA` to `BBBB`, with mtimes of approximately
`1700000000123.1008` and `1700000000123.4` ms. Both calls returned the first
upload, and the fake API observed only `AAAA`. No live Gemini call was made.

**Recommendation:** Use a content-based identity, or an explicitly documented
invalidation strategy that cannot silently reuse a different revision. Avoid
discarding available timestamp precision, and add tests for same-size rewrites,
including preserved and sub-millisecond mtimes.

### [Resolved] P2 — A saved frame set can bypass the MCP inline-image budget

**Status: Resolved.** All frames, including the first, are subject to the 2 MiB
base64 budget; reads are bounded even if a file grows after its size check.

**Locations:** [extractFrames.ts](../../src/operations/extractFrames.ts#L107),
[extractFrames.ts](../../src/operations/extractFrames.ts#L138),
[envelope.ts](../../src/adapters/envelope.ts#L79).

Paging accepts a caller-supplied frame-set directory and checks that each file
is nonempty, but not its size or image contents. `loadImages` intentionally
always reads and inlines the first file, regardless of the advertised 2 MiB
base64 budget. An oversized or modified saved frame can therefore cause a large
memory allocation and an oversized MCP response, potentially failing the
transport or client. This is distinct from the documented normal-frame
exception: a saved file has no enforced upper bound.

**Evidence:** A synthetic saved frame set with one 3 MiB file produced a
4 MiB base64 image in the MCP tool result. The test did not require a valid
JPEG, because the paging path accepts any nonempty regular file.

**Recommendation:** Enforce a hard per-image limit before reading, including
the first image, and report oversized images by path or with a clear error.
Bound the read itself against file changes between the size check and read.
Test oversized first images and modified frame sets.

### [Resolved] P3 — MCP drops labels and paths for inlined frames

**Status: Resolved.** Each inlined image is preceded by its path and label;
skipped images retain their path and label in the result.

**Locations:** [extractFrames.ts](../../src/operations/extractFrames.ts#L138),
[mcpTools.ts](../../src/adapters/mcpTools.ts#L24).

The operation creates a path and timestamp label for each image, but the MCP
adapter emits only the image bytes and MIME type for inlined images. Its
separate data block contains the page's timestamps, while only skipped images
are described by path and label. When some images are skipped, clients must
infer which remaining image corresponds to which timestamp instead of receiving
an explicit mapping. The CLI retains the image metadata.

**Recommendation:** Include an ordered text or structured mapping for every
inlined and skipped image, preserving the path and label next to its content.
Cover a page where a middle image is skipped but a later image fits.

### [Resolved] P3 — Temporary-media cleanup failures are invisible

**Status: Resolved.** Removal failures are logged with the directory and
manual-cleanup guidance without replacing the original operation error.

**Locations:** [fsUtils.ts](../../src/utils/fsUtils.ts#L21),
[mediaInput.ts](../../src/services/mediaInput.ts#L134),
[getVideoInfo.ts](../../src/operations/getVideoInfo.ts#L74).

`removeDir` suppresses every removal error, not just an already-missing
directory. Consequently, a successful operation can leave a downloaded copy
of sensitive media on disk without warning when deletion fails. Startup
sweeping is also best-effort, so it does not guarantee eventual removal.

**Recommendation:** Surface a cleanup warning or log for failures other than an
already-removed directory, without masking an original operation error. Add a
test for failed removal and document the residual-file recovery path.

## Verification and limitations

- Remediation tests cover preserved-mtime rewrites, concurrent uncached uploads,
  timestamp boundaries, longer audio, frame-page labels, oversized and growing
  MCP images, and failed cleanup.
- Before remediation, `npm run check` passed with 262 tests passed and one
  skipped; all 20 local-media integration tests ran.
- After remediation, `npm run check` passed with 268 tests passed and one
  skipped; all 22 local-media integration tests ran.
- The skipped test requires Windows file-symlink creation privileges.
- Reproductions used Node 26.11.1, FFmpeg 9.0.2, generated media, a fake Gemini
  API, and synthetic frame-set files. Temporary reproduction files were removed.
- No live Gemini call or production-scale load test was performed. The
  [README](../../README.md#known-limitations) already documents the DNS
  resolve-to-connect rebinding limitation; it remains a deployment risk.
