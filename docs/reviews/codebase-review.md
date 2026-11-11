# Codebase Review

Reviewed: 2026-11-11

## Scope and assessment

Reviewed the current working tree, including uncommitted changes, across the CLI,
MCP adapter, operations, media and Gemini services, configuration, and tests.
The shared operation registry and interface-parity tests are good foundations;
frame budgets, cancellation, and upload coalescing also have focused coverage.

The principal concerns are a possible source-file overwrite during transcription,
incorrect interval-frame timestamps, and remote-download error handling. These
findings describe the code as originally reviewed, not a comparison with the last
commit. All five were subsequently addressed as described below.

## Findings

### [Resolved] P1 — Transcript output can overwrite the source after the alias check

**Status: Resolved.** Overwrites stage a new file and rename it over the target
entry without truncating through a link. The existing no-overwrite path remains
exclusive.

**Location:** [transcribeVideo.ts](../../src/operations/transcribeVideo.ts#L146).

The source/target identity check happens before media preparation and Gemini
generation. With `overwrite: true`, the eventual `writeFile` opens the target
with `w` and follows links without checking the opened file's identity. If
another process replaces the target with a hard link or symlink to the source
while generation is in progress, the write truncates the source.

**Evidence:** With a generated MP4 and a fake Gemini service that created a hard
link at the output path during generation, the operation reported
`outputWritten: true` and replaced the 2,217-byte source with the 11-byte
transcript.

**Recommendation:** Write to a new temporary file in the target directory and
atomically replace the directory entry, rather than truncating an existing
target through a link. Preserve the existing no-overwrite semantics and handle
platform-specific replacement failures explicitly. Add a regression test that
changes the target into a source alias during generation.

### [Resolved] P2 — Interval frame times describe the resampled timeline, not source frames

**Status: Resolved.** Interval labels are explicitly approximate sampling-grid
times, with a warning on every page, including previously saved frame sets.

**Locations:** [ffmpeg.ts](../../src/services/ffmpeg.ts#L394),
[extractFrames.ts](../../src/operations/extractFrames.ts#L92).

`showinfo` runs after the `fps` filter, which rewrites presentation timestamps
onto the output sampling grid. The code nevertheless marks these values exact
and uses them as image labels. An FFmpeg test with a 2 fps source and a 2-second
interval showed the frame with source PTS 0.5 seconds emitted with PTS 0
seconds. Callers can therefore associate the wrong moment with an image, with
no warning. The unit test mocks `showinfo` output rather than checking source
frame identity.

**Recommendation:** Preserve or recover the selected source-frame timestamps,
or explicitly report the output times as approximate sampling-grid labels.
Add an integration test using visually distinguishable or checksummed source
frames and compare each returned label with the selected source frame.

### [Resolved] P2 — Interval extraction can fail on valid short clips

**Status: Resolved.** Interval sampling uses upward rounding to include a frame
for short clips; underproduction is no longer automatically blamed on the frame
budget.

**Location:** [ffmpeg.ts](../../src/services/ffmpeg.ts#L394).

The expected frame count assumes at least one frame for any positive duration,
but the `fps` filter can emit none when the clip is shorter than the sampling
interval. On the reviewed FFmpeg build, a generated 0.4-second clip with
`intervalSec: 1` failed with `MEDIA_PROCESSING_FAILED` because the output
encoder received no frames. On other builds, an empty result may instead be
returned. This is a valid request and the error does not explain the sampling
condition.

**Recommendation:** Define and implement short-clip sampling semantics
consistently, including whether the first frame is returned, and align
`expectedFrames`, truncation warnings, and documentation with the actual
selection. Exercise short clips and intervals near the duration boundary with
real FFmpeg.

### [Resolved] P2 — Rejected HTTP response bodies remain active

**Status: Resolved.** HTTP-error and oversized declared-length response bodies
are canceled before the error is returned.

**Location:** [net.ts](../../src/utils/net.ts#L336).

The redirect branch cancels its response body, but the non-success status and
oversized `Content-Length` branches throw without consuming or canceling it.
The caller can receive a failure while the peer continues sending data and the
connection remains open until the request timeout or another cleanup event.
Repeated rejected downloads can consume bandwidth and connections despite the
configured size guard.

**Evidence:** A local server declaring an oversized response continued sending
34 chunks in the half-second after `downloadToFile` rejected; its response was
still open.

**Recommendation:** Cancel or otherwise dispose of the response body on every
early rejection, including HTTP errors, while preserving the original error.
Test a streaming server that declares an oversized body and one returning an
error status.

### [Resolved] P2 — Download errors expose signed URL query parameters

**Status: Resolved.** User-facing URL diagnostics remove credentials, query
strings and fragments; malformed redirect locations are also handled without
echoing their contents.

**Locations:** [net.ts](../../src/utils/net.ts#L157),
[mediaInput.ts](../../src/services/mediaInput.ts#L125).

Failure messages and error details can contain the complete URL, including its
query string. The CLI serializes these details to stdout, and some messages are
also returned to MCP clients or written to stderr. Signed media URLs commonly
carry bearer credentials in the query, so failures can leak them into logs,
agent transcripts, or other consumers of the error.

**Evidence:** A local HTTP 403 response produced an error envelope whose `url`
included a test `token` query parameter.

**Recommendation:** Redact query strings and fragments from URLs in all
user-facing errors and diagnostic details, including redirect and MIME-type
failures. Keep the unredacted URL only where it is needed to make the request.
Add error-path tests using synthetic signed URLs.

## Verification and limitations

- Remediation regression tests cover a hard-link race, failed output staging,
  short and boundary-length clips, real source-frame identity, HTTP body
  cancellation, and signed-URL redaction, including redirects.
- After remediation, `npm run check` passed with 262 tests passed and one
  symlink test skipped; all 20 local-media integration cases ran.
- `npm run check` passed: typecheck, lint, build, 247 tests, and formatting;
  this was the original review baseline. One transcription symlink test was
  skipped because symlink creation was unavailable. All 16 original local-media
  integration cases ran.
- Additional reproductions used Node 26.11.1, FFmpeg 9.0.2, generated files,
  fake Gemini responses, and local-only HTTP servers. Temporary files were
  removed. No live Gemini calls were made.
- The documented DNS-rebinding limitation remains: URL validation and the
  subsequent connection are not pinned to the same resolved address. This
  review did not attempt an exhaustive security audit or production load test.
