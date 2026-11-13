# Codebase review

Reviewed: 2026-11-13

## Summary

The project has a coherent shared operation registry for the CLI and MCP adapters,
strict TypeScript settings, and substantial automated coverage. Local media
integration tests and the normal build, typecheck, and lint checks passed on
Windows. Four issues merit attention: platform downloads can exceed the
configured disk budget, downloader diagnostics can expose signed URLs, some
platform pages never reach the downloader, and a failed cache write is not
retried.

Severity describes impact in the stated circumstances, not a claim that every
deployment is affected. All four findings are fixed; see
[Resolution](#resolution).

## Findings

### P1 - Platform downloads can exceed the configured size limit on disk

**Locations:** [ytdlp.ts:107](../../src/services/ytdlp.ts#L107),
[ytdlp.ts:328](../../src/services/ytdlp.ts#L328),
[README.md:297](../../README.md#L297).

The downloader passes `--max-filesize` to yt-dlp but checks the actual output
size only after the subprocess exits. An unknown-length transfer can therefore
write beyond `VIDEO_ANALYZER_DOWNLOAD_MAX_MB` before the application rejects it.
With a local chunked HTTP response, a 1 MiB limit, and the installed yt-dlp, the
downloader wrote a 2 MiB file and only then returned `DOWNLOAD_FAILED`. Longer
or concurrent downloads can exhaust temporary disk space despite the configured
limit; the timeout limits duration, not bytes.

**Recommendation:** Enforce an aggregate byte or disk budget while platform
downloads are running, including partial files and separate streams, and stop
the subprocess when it is exceeded. Add a real-downloader regression test with
an unknown-length response; a mocked oversized output only verifies the
post-download check.

**Status:** Resolved. `downloadThroughGuard` now watches the destination
directory and kills the downloader when the total footprint passes the limit.

### P1 - Downloader errors expose query-string credentials

**Locations:** [ytdlp.ts:125](../../src/services/ytdlp.ts#L125),
[ytdlp.ts:135](../../src/services/ytdlp.ts#L135),
[egressGuard.ts:178](../../src/services/egressGuard.ts#L178).

The last lines of yt-dlp stderr are copied verbatim into error details and, for
some failures, hints. yt-dlp can include the complete input URL in those lines.
A local unsupported-page reproduction returned an error envelope containing
the synthetic `?token=review-test-token` query. Signed URLs and their bearer
tokens can consequently reach CLI output, clients, or logs. The egress guard
also logs an unredacted target at debug level.

**Recommendation:** Sanitize URLs in subprocess diagnostics and proxy logs,
including query strings, fragments, and credentials, before publishing them.
Test both structured error details and hints with synthetic signed URLs; avoid
relying only on redaction in the direct-download code.

**Status:** Resolved. `redactUrlsInText` sanitizes downloader output before it
becomes a hint or detail, and the proxy logs redacted targets.

### P2 - A page that rejects the preliminary GET never reaches yt-dlp

**Locations:** [mediaInput.ts:100](../../src/services/mediaInput.ts#L100),
[mediaInput.ts:118](../../src/services/mediaInput.ts#L118),
[net.ts:525](../../src/utils/net.ts#L525),
[shared.ts:299](../../src/operations/shared.ts#L299).

Platform fallback happens only after a successful direct GET returns HTML.
When the initial request returns 403, 429, or another non-success status,
`downloadToFile` throws before yt-dlp is called. A local HTML endpoint returning
403 reproduced this. This also affects the fallback after Gemini rejects a
YouTube URL. In particular, configured yt-dlp cookies or impersonation cannot
help when the unauthenticated preliminary GET is itself blocked.

**Recommendation:** Route eligible page URLs to the guarded downloader without
requiring a successful unauthenticated body download, while preserving per-hop
URL policy and direct-media error handling. Cover blocked page responses,
cookies/impersonation, and provider fallback in regression tests.

**Status:** Resolved. A refused response is retried through the guarded
downloader unless it is identifiable as media; unsupported or missing-downloader
failures keep the original HTTP error. `downloadToFile` now reports the response
status and content type that this decision needs.

### P2 - A failed persistent-cache write discards the queued update

**Locations:** [uploadCache.ts:144](../../src/services/uploadCache.ts#L144),
[uploadCache.ts:224](../../src/services/uploadCache.ts#L224),
[uploadCache.ts:253](../../src/services/uploadCache.ts#L253).

`writePending` removes operations from `pending` before writing and renaming
the staging file. If either step fails, `flush` logs the error but does not put
those operations back. A later `flush` has nothing to retry, although the
in-memory entry remains. In a local reproduction, making the target path a
directory caused the rename to fail; removing that obstruction and flushing
again did not persist the entry. A fresh process therefore reuploads content
and repeats processing after a transient filesystem failure.

**Recommendation:** Restore failed operations to the queue in their original
order, preserving any newer updates, and retry on a subsequent flush. Test a
real write or rename failure followed by recovery, plus concurrent updates.

**Status:** Resolved. `writePending` returns failed operations to the front of
the queue before the error is reported, so the next flush retries them.

## Resolution

| Finding                               | Change                                                                                                                                      | Regression test                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Download size enforcement             | Watchdog over the download directory; the child process is killed once the aggregate limit is passed.                                       | `ytdlp` stops a download that outgrows the limit while running |
| Diagnostics leaking signed URLs       | URL redaction applied to downloader output and proxy logs, including query-only fragments.                                                  | `ytdlp`, `net` redaction cases                                 |
| Refused page bypassing the downloader | Authentication and rate-limit failures (401, 403, 407, 429) retry through the guarded downloader unless the response is identifiable media. | `mediaInput` refused-page, refused-media, and 404 cases        |
| Lost cache writes                     | Failed operations return to the pending queue for the next flush.                                                                           | `uploadCache` retry after a real rename failure                |

The installed yt-dlp was used to confirm the first two fixes end to end: an
unknown-length response is now stopped at the limit instead of being written in
full, and the reproduced 403 page error no longer contains its query token. A
real `EPERM` rename failure followed by a retry now persists the reference.

The size limit is enforced by polling the destination directory, so a fast
transfer can exceed the limit by roughly one polling interval of data before the
process is killed. The temporary directory is removed when the download fails.

## Validation and limits

- `npm run typecheck`, `npm run lint`, and `npm test` passed on Windows with
  Node 26.11.1: 421 tests passed and 2 were skipped. The skips were the
  opt-in live Gemini test and one platform-dependent transcription test.
- Local, synthetic HTTP and filesystem probes reproduced the four findings
  before the fixes and confirmed them afterwards. No real signed URL, external
  platform, or live Gemini request was used.
- The default CI runs on Ubuntu with Node 22 only
  ([ci.yml](../../.github/workflows/ci.yml)); consider a Windows job for the
  documented Windows launcher and filesystem behavior.
- Live Gemini routing and third-party platform compatibility remain unverified
  by this review. This is a risk-focused code review, not an exhaustive security
  audit or a guarantee about external services.
