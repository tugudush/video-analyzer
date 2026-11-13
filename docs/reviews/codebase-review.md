# Codebase review

Reviewed: 2026-11-13  
Revision: `c3cc86b` (working tree)

## Summary

The shared operation registry and adapters provide a consistent interface, and
the project has extensive unit and local integration coverage. The most
important gaps were in the remote-input security boundary and in behaviors that
the tests did not exercise: URL fallback, cache lock contention, and format
selection.

Every finding below was fixed in this change. Each entry keeps the original
evidence and records the resolution and the tests that cover it. Priorities
describe impact and urgency, not certainty that a particular deployment was
exposed.

## Behavior changes

- yt-dlp traffic now goes through a loopback guard, so a platform page that
  points at a private or reserved destination fails with `DOWNLOAD_FAILED`
  unless `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true`. Public platform downloads are
  unaffected.
- `YT_DLP_MAX_RESOLUTION` now also applies to the last-resort format
  alternatives. A site that only offers known over-cap streams fails with the
  existing "raise `YT_DLP_MAX_RESOLUTION`" guidance instead of silently
  downloading a larger file.
- A fallback download reports `source: "download"`, and its duration is probed
  when `ffprobe` can read it.

## Findings

### P1 - The direct-media probe does not pin validated DNS addresses

**Locations:** [mediaRouting.ts](../../src/services/mediaRouting.ts#L70),
[net.ts](../../src/utils/net.ts#L241)

The HEAD probe calls `assertSafeHttpUrl`, which resolves and validates the host
but returns only the URL. The subsequent `fetch` performs its own DNS lookup
without the pinned-address dispatcher used by `downloadToFile`. A hostname that
changes from a public address during validation to a private address during
connection can therefore make the probe contact a private service even when
`VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS` is false. This affects AI operations that
probe non-YouTube URLs, including each redirect hop. The download path's
address pinning does not protect the earlier HEAD request.

**Recommendation:** Share the validation and pinned-connection mechanism with
the probe, including per-hop checks. Add a test that makes validation and
connection resolve differently and verifies that the connection cannot use an
unvalidated address.

**Status:** Resolved. [net.ts](../../src/utils/net.ts) now exports `fetchPinned`,
which validates every hop and issues each request through an agent bound to the
addresses it validated; the probe uses it instead of validating and then letting
`fetch` resolve again. Tests in `mediaRouting.test.ts` cover the pinned
dispatcher, a host that resolves to a private address, and cancellation during
DNS resolution.

### P1 - Platform extraction can reach private destinations from a public page

**Locations:** [mediaInput.ts](../../src/services/mediaInput.ts#L115),
[ytdlp.ts](../../src/services/ytdlp.ts#L199),
[README.md](../../README.md#L302)

The initial HTML response is fetched through the guard, but yt-dlp independently
fetches the page and its derived media URLs. Those requests are not restricted
by `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS`; a public page can point the generic
extractor at a private destination. This is relevant when URL or page content is
untrusted, even though the README acknowledges that yt-dlp has its own network
access.

An isolated loopback experiment called `downloadFromPlatform` with private hosts
disabled and an HTML page referencing a second loopback server: yt-dlp contacted
that server and returned its media. This demonstrates the downloader boundary,
not an end-to-end public-page exploit.

**Recommendation:** Enforce destination policy on _all_ downloader requests,
for example through an appropriately restricted network boundary, or disable
platform extraction for untrusted URLs. Make the exposure and deployment
requirements explicit. Add a regression test covering a public page with a
private derived destination.

**Status:** Resolved. New [egressGuard.ts](../../src/services/egressGuard.ts)
runs a loopback proxy that applies `resolveSafeHttpUrl` and address pinning to
plain HTTP requests and CONNECT tunnels, and `downloadFromPlatform` starts it and
passes `--proxy`. A refused hop is recorded and reported as `DOWNLOAD_FAILED`
naming the blocked destination. Re-running the loopback experiment now blocks the
derived media request, and succeeds with the opt-in. Tests:
`tests/unit/egressGuard.test.ts` and the `--proxy` case in `ytdlp.test.ts`.

### P2 - Normal Gemini URL rejections never trigger the download fallback

**Locations:** [gemini.ts](../../src/services/gemini.ts#L678),
[mediaRouting.ts](../../src/services/mediaRouting.ts#L195),
[shared.ts](../../src/operations/shared.ts#L273)

`generate` wraps ordinary SDK errors with a generic hint containing both
`API key` and `quota`. `isDirectUrlRejection` includes that hint in its
classification text and rejects _any_ text matching either term. Consequently,
even a cause such as `unable to fetch URL` is classified as non-retryable, and
the documented download/upload fallback is not attempted. This affects both
YouTube and eligible direct-file URLs.

**Verification:** A local direct-URL operation using a mocked provider that
threw `unable to fetch URL` returned `GEMINI_REQUEST_FAILED` without uploading;
the classifier also returned `false` for the production wrapper shape.

**Recommendation:** Classify the provider's error separately from generic
recovery hints, preferably using structured error details where available. Test
the complete provider-error-to-fallback path as well as authentication, quota,
cancellation, and timeout failures that must not fall back.

**Status:** Resolved. `isDirectUrlRejection` now inspects only the provider
message and its cause, so the generic recovery hint can no longer mask a URL
rejection. Tests: the classification table in `mediaRouting.test.ts` and the
end-to-end fallback and quota cases in `aiRouting.test.ts`.

### P2 - Cache writes proceed without owning the lock

**Locations:** [uploadCache.ts](../../src/services/uploadCache.ts#L202),
[uploadCache.ts](../../src/services/uploadCache.ts#L263)

When lock acquisition times out or fails, `acquireLock` returns a no-op release
function; `writePending` then reads, merges, and replaces the cache anyway. A
new cache directory also causes the first lock attempt to fail with `ENOENT`
because the directory is created only after the merge. Concurrent processes can
therefore overwrite each other's updates despite the stated cross-process
merge guarantee. The timeout warning even says the write is being skipped.

**Verification:** With a live lock file held, a pending write completed and
changed the cache while the lock still existed. A first write to a nonexistent
cache directory also succeeded after logging a lock error.

**Recommendation:** Create the directory before acquiring the lock; only merge
and write after successful acquisition. On contention or lock errors, skip or
retry without losing pending operations. Test real overlapping writers, lock
timeout, and first use of a new directory.

**Status:** Resolved. `writePending` creates the directory first, `acquireLock`
returns `undefined` instead of a no-op release, and a write that cannot take the
lock leaves its operations queued for the next flush. Tests: "creates a missing
cache directory before taking the lock" and "skips the write while a lock is
held, then retries it".

### P2 - Probe DNS lookup ignores cancellation and its deadline

**Locations:** [mediaRouting.ts](../../src/services/mediaRouting.ts#L70),
[net.ts](../../src/utils/net.ts#L241)

The probe constructs a timeout and combined caller signal, but does not pass
either to `assertSafeHttpUrl`; that helper calls the DNS resolver without a
signal. A stalled lookup can keep an AI operation pending after cancellation or
past the probe deadline, before `fetch` receives its signal.

**Verification:** With DNS mocked to never settle, aborting the caller left the
probe pending. No external network was used.

**Recommendation:** Bound DNS resolution with the same combined signal used by
the probe, and preserve the distinction between caller cancellation and probe
timeout. Test cancellation and timeout while DNS is unresolved.

**Status:** Resolved with the pinned fetch: the probe's combined signal now
reaches `resolveSafeHttpUrl`, which passes it to the resolver. The
"stops waiting when the caller cancels during DNS resolution" test covers it.

### P2 - yt-dlp format fallback bypasses the configured resolution cap

**Locations:** [ytdlp.ts](../../src/services/ytdlp.ts#L53),
[README.md](../../README.md#L293)

The final `best[ext=mp4]/best` alternatives omit the height filter. If no
eligible format is at or below `YT_DLP_MAX_RESOLUTION`, yt-dlp can select a
larger video rather than fail, contrary to the documented cap. This may also
increase download size and processing costs.

**Verification:** An offline yt-dlp simulation with only a 1080p format selected
1080p using the selector configured for 720p.

**Recommendation:** Apply the height constraint to all alternatives and define
how unknown-height formats are handled. Test an inventory containing only
over-cap formats and one containing both eligible and over-cap formats.

**Status:** Resolved. Every alternative now uses `[height<=?<cap>]`, which
excludes known over-cap streams while still matching formats that report no
height, such as audio-only and some adaptive streams. Verified with
`yt-dlp --simulate --load-info-json` against synthetic format inventories, and
covered by "keeps the height cap on every alternative".

### P3 - A successful URL fallback reports the wrong source

**Locations:** [shared.ts](../../src/operations/shared.ts#L273),
[shared.ts](../../src/operations/shared.ts#L332)

When a URL-specific `VideoAnalyzerError` does trigger fallback,
`generateFromDownload` uploads the downloaded file but the enclosing session
still returns `source: 'gemini-url'`. Operations also warn that Gemini fetched
the media directly. Duration remains unknown because the fallback does not
probe the downloaded file. This can mislead callers about how their media was
handled; the normal SDK error path is additionally affected by the earlier
fallback-classification finding.

**Verification:** A mocked URL rejection followed by successful upload returned
`source: 'gemini-url'` and the direct-fetch warning.

**Recommendation:** Propagate the route actually used and report missing
metadata accurately, or probe the fallback download if local metadata is
required. Test the returned source and warnings after a successful fallback.

**Status:** Resolved. `generateFor` and `generateFromDownload` return the route
and metadata they actually used, `withAiMedia` reports those, and the fallback
probes the downloaded file (a probe failure keeps the metadata unknown and uses a
warning that no longer claims Gemini fetched the media). Tests: "reports the
download route and probed metadata when the provider rejects the URL".

## Validation and scope

- `npm run check` passed after the fixes: typecheck, lint, build, tests, and
  formatting. Vitest reported 29 passed test files plus one skipped file, 412
  passed tests, and two skipped tests.
- New coverage: `tests/unit/egressGuard.test.ts` (blocked and allowed plain
  requests, blocked and allowed tunnels, and a client reset after a refusal),
  probe pinning and cancellation cases in `mediaRouting.test.ts`, the
  URL-rejection table, the lock-contention and missing-directory cases in
  `uploadCache.test.ts`, the resolution-cap cases in `ytdlp.test.ts`, and the
  fallback route/quota cases in `aiRouting.test.ts`.
- Verified with the real downloader: a loopback page pointing at a private media
  host is now blocked, the same download succeeds with
  `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true`, and a public media URL downloads
  through the guard.
- The live Gemini integration test was skipped; no provider credentials or
  external media were used. The downloader and URL fallback experiments used
  synthetic data and loopback servers only.
- Findings and resolutions are based on the implementation, tests, documentation,
  and the targeted experiments above. This is not a comprehensive security audit
  or a guarantee that no other defects exist.
