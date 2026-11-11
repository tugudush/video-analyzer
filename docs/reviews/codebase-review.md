# Codebase review

Reviewed 2026-11-12 against commit `927c5fe` and the working tree. This is a
correctness, reliability, and maintainability review, not a penetration test.
The findings below were written before remediation and describe the pre-fix
state; their source links point at that commit, so line numbers may have shifted
since.

## Remediation status — 2026-11-12

All four findings are fixed and covered by regression tests.

- **P1/P2 (Gemini upload):** Uploads no longer pass request-level
  `httpOptions`, which had replaced the SDK's resumable-upload URL and
  protocol headers. Every SDK request made for an upload is now bound to the
  caller's signal and the call deadline through an injected fetch transport, so
  cancellation and timeouts reach the initialization request and every chunk.
  The new tests drive the real SDK through a fake transport and assert the
  initialization URL and headers, plus that a cancel or deadline aborts the
  chunk request.
- **P2 (cover art):** `attached_pic` streams are excluded from video detection,
  and every extraction mode maps the probed stream index instead of the first
  video stream. Generated MP3 cover art is now reported as audio-only and
  rejected by `extract_frames`; regression tests cover cover-only and
  cover-plus-video media in all four extraction modes.
- **P3 (remote image):** A missing or generic `Content-Type` now falls back only
  to a media extension, so remote images are rejected like their local
  counterparts.

`npm run check` passes: typecheck, lint, build, 21 test files, 307 tests passed
and 1 skipped, and formatting. No live Gemini request was performed, so a
provider-side upload was not exercised.

| Finding                                            | Status      |
| -------------------------------------------------- | ----------- |
| P1 — Gemini upload URL and headers                 | ✅ Resolved |
| P2 — Upload cancellation leaves the transfer alive | ✅ Resolved |
| P2 — Audio cover art treated as video              | ✅ Resolved |
| P3 — Remote image bypasses media-type validation   | ✅ Resolved |

## Summary

The shared operation registry keeps the CLI and MCP interfaces aligned.
Validation, bounded frame extraction, per-hop download checks, isolated logging,
and focused unit and integration tests are strengths.

Four issues were reproduced before remediation. The first was a release blocker
for the installed Gemini SDK: the upload request was constructed with an
incorrect URL and missing resumable-upload headers. Cancellation also did not
stop the actual SDK upload. Two lower-impact media classification issues
affected audio with cover art and remote images without a content type.

Severity: **P1** blocks a core capability; **P2** is a meaningful defect under
the stated conditions; **P3** is lower impact.

## Findings

### P1 — Gemini upload requests lose the SDK's required upload configuration

- **Status:** ✅ **Resolved.** The upload adapter no longer supplies
  request-level `httpOptions`, restoring the SDK's upload URL and protocol
  headers. Covered by a real-SDK transport test that asserts
  `/upload/v1beta/files` and the `x-goog-upload-*` headers. Not verified
  against the live provider.
- **Evidence:** The [SDK wrapper](../../src/services/gemini.ts#L55) always
  supplies `httpOptions.timeout` for a service upload. With the locked
  [`@google/genai` 2.32.0](../../package-lock.json#L32), supplying
  `httpOptions` replaces the SDK's upload-specific options instead of extending
  them. Its upload initialization therefore loses both the empty API version
  and the resumable-upload headers.
- **Reproduced:** With the real installed SDK and an intercepted local fake
  `fetch`, a direct SDK upload without `httpOptions` requested
  `/upload/v1beta/files` with the `x-goog-upload-*` headers. The application's
  wrapper requested `/v1beta/upload/v1beta/files` with none of those headers.
  No request was sent to Gemini.
- **Impact:** All four Gemini-backed operations pass through this upload path.
  They are expected to fail to initialize uploads with the locked SDK, even
  with a valid key and media. The live provider response was not verified.
- **Recommendation:** Use a supported SDK upload configuration that preserves
  the required path and protocol headers, or move to a verified SDK version
  that handles request options correctly. Add a test around the real SDK
  transport that checks the initialization URL and headers; service-level
  mocks alone cannot detect this mismatch.

### P2 — Cancelling an upload leaves the underlying SDK transfer running

- **Status:** ✅ **Resolved.** The upload's initialization and chunk requests are
  now bound to the caller's signal and call deadline through an injected fetch
  transport. Regression tests cancel and time out a real-SDK upload through a
  fake transport and assert the chunk request is aborted.
- **Evidence:** The [wrapper](../../src/services/gemini.ts#L91) passes an abort
  signal and timeout to `files.upload`, while
  [`runWithBounds`](../../src/utils/abort.ts#L32) can return before ignored work
  settles. In the installed SDK, upload initialization does not receive the
  caller's abort signal, and the subsequent file upload does not receive that
  signal or the per-request HTTP options.
- **Reproduced:** Using the real SDK with a fake transport that accepted upload
  initialization, canceling during the chunk request returned
  `OPERATION_CANCELLED`; the chunk request had no abort signal and completed
  afterward. This test deliberately accepted initialization despite the P1
  defect, so the cancellation problem remains relevant after P1 is fixed.
- **Impact:** The caller can be told an operation was canceled or timed out
  while media is still being transferred. This wastes bandwidth and can leave
  provider-side media after the caller believes the transfer stopped; temporary
  source cleanup can also race the still-running SDK work.
- **Recommendation:** Ensure the actual initialization and every upload chunk
  honor cancellation and deadlines using a verified SDK capability or another
  supported upload implementation. Test the real transport boundary, including
  cancellation during both stages and source lifetime during cleanup.

### P2 — Audio cover art is treated as a video stream

- **Status:** ✅ **Resolved.** `attached_pic` streams are excluded from video
  detection and every extraction mode maps the probed stream index. Verified
  with generated MP3 cover art and unit/integration tests covering cover-only,
  cover-plus-video, and all four extraction modes.
- **Evidence:** [Metadata selection](../../src/services/ffmpeg.ts#L148)
  treats the first stream with `codec_type: video` as video without checking
  `disposition.attached_pic`. [Frame extraction](../../src/operations/extractFrames.ts#L282)
  relies on that classification and maps the first video stream.
- **Reproduced:** A two-second MP3 with a single attached JPEG was reported as
  `hasVideo: true`, with no audio-only warning. Timestamp extraction succeeded
  and returned the album cover as a video frame.
- **Impact:** Audio-only inputs can be misrepresented as videos, and extracted
  stills can be presented as visual evidence from a recording. A real video
  preceded by an attached picture can likewise select the wrong stream.
- **Recommendation:** Exclude attached-picture streams when determining whether
  motion video exists, and use the same selected stream for metadata and every
  extraction mode. Add audio-with-cover and cover-plus-video fixtures, and
  update the documented first-video-stream rule as appropriate.

### P3 — A remote image without Content-Type bypasses media-type validation

- **Status:** ✅ **Resolved.** The fallback MIME type must now be a media type,
  so remote images are rejected with `UNSUPPORTED_INPUT` even when the server
  omits `Content-Type`. Verified with a local HTTP server and a regression
  test.
- **Evidence:** [Local input validation](../../src/services/mediaInput.ts#L77)
  requires an audio or video MIME type, but the
  [downloaded-input fallback](../../src/services/mediaInput.ts#L110) accepts
  any known extension when the response has no `Content-Type`. The MIME table
  also includes image extensions.
- **Reproduced:** A local HTTP server returned a JPEG at `sample.jpg` without a
  `Content-Type` header. With private hosts explicitly enabled,
  `get_video_info` accepted it as direct media and reported a video stream.
- **Impact:** Non-media inputs can be reported as videos or sent to Gemini
  under an image MIME type, unlike the same local file or a response explicitly
  labeled `image/jpeg`.
- **Recommendation:** Require the final inferred MIME type to pass
  `isMediaMimeType`, regardless of whether it came from the response or URL.
  Cover absent and generic content types with media and image extensions.

## Additional risks and coverage

- The previous review's resolved findings were not assumed to remain open.
- Gemini request and response tests mostly use injected API doubles, and the SDK
  response tests mock the SDK itself. The new upload transport tests use the
  real SDK, but no live Gemini request was made, so credentials, model
  availability, quotas, provider-side retention, and actual service responses
  were not verified.
- No CI workflow is tracked in this checkout. Repeat checks across supported
  Node versions and operating systems with FFmpeg installed.
- The README appropriately describes URL filtering as defense in depth and
  documents provider-side media retention; this review did not establish a
  security boundary for untrusted media.

## Verification

| Check                  | Result                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run check`        | Passed after remediation: typecheck, lint, build, 21 test files, 307 tests passed and 1 skipped, and formatting.        |
| Targeted reproductions | Confirmed all four findings before the fix and their absence after it, using generated media and local fake transports. |
| Environment            | Windows, Node 26.11.1, FFmpeg/ffprobe 9.0.2, locked `@google/genai` 2.32.0.                                             |

A green suite does not establish that a real Gemini upload succeeds, or that
other supported platforms and Node versions were exercised. The SDK transport is
now tested against the locked SDK, but the provider response itself was not.
