# Media routing and caching plan

> **Status:** implemented in one pass, with two open gates. See
> [progress.md](./progress.md) for what landed, the deviations, and what is
> still unverified. In short: routing, snapshots, and the opt-in persistent
> cache are in place and covered by tests; the yt-dlp network gate (Plan 0.2)
> and authorized live validation against the real Gemini endpoint remain open.

## Goal and scope

Route eligible public media directly to Gemini. For other supported remote
media, download with yt-dlp, then upload the downloaded file to Gemini or reuse
an eligible cached Gemini upload. Reuse Gemini uploads for unchanged local
media too. This is a plan; none of the new routing or local caching described
here is implemented yet.

The policy applies to AI operations: `analyze_video`, `summarize_video`,
`search_timestamp`, and `transcribe_video`. `get_video_info` and
`extract_frames` require local media and continue to download remote inputs
with yt-dlp. A file previously downloaded by yt-dlp and passed as a path or
`file://` URI is a local file.

## Routing decisions

| Input to an AI operation                                                                   | Planned behavior                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Public YouTube video                                                                       | Pass its URL directly to Gemini; no local media download or Files API upload.                         |
| Private, unlisted, or otherwise YouTube-ineligible video                                   | Download with yt-dlp, using configured cookies when needed; upload to Gemini or reuse a valid upload. |
| Public direct HTTPS media URL, known to be at most 15 MB, with a supported MIME type       | Pass its URL directly to Gemini; no local media download or Files API upload.                         |
| Other remote media, including larger or unknown-size direct files and other platform pages | Download with yt-dlp, then upload to Gemini or reuse a valid upload.                                  |
| Local file, including a separately downloaded yt-dlp file                                  | Snapshot and hash locally, then reuse a valid Gemini upload or upload the snapshot.                   |

This is best-effort routing, not a promise that Gemini or yt-dlp can access
every video. Errors remain visible. Direct Gemini inputs are fetched by Google
for processing; they do not pass through our Gemini Files upload cache and this
plan does not claim Google caches them.

Examples:

1. A public YouTube URL asked about twice goes to Gemini twice; the analyzer
   downloads and uploads no video bytes on either AI request.
2. A private YouTube URL uses yt-dlp with the user's configured cookies, then
   Gemini upload. Repeating it downloads again; an identical content hash may
   avoid a second upload when a valid upload reference is available.
3. A public 10 MB MP4 HTTPS URL is handed directly to Gemini. A 20 MB or
   unknown-size URL is downloaded with yt-dlp, then uploaded to Gemini unless
   an identical upload can be reused.
4. `C:\Videos\talk.mp4`, including a file the user downloaded with yt-dlp, is
   read and snapshotted for each AI call. Unchanged bytes can reuse the upload;
   changed bytes require a new upload.
5. Requesting frames or technical metadata for the public YouTube video still
   downloads it: these operations do not use Gemini.

### Provider limits and verification

Google's [video understanding guide](https://ai.google.dev/gemini-api/docs/video-understanding#youtube)
describes YouTube URL input as a preview and says only public videos are
supported. It documents an 8-hour/day free-tier YouTube-video limit; pricing
and limits may change. Google's [file input guide](https://ai.google.dev/gemini-api/docs/file-input-methods#external-urls)
documents HTTPS direct-file fetching up to 15 MB per file and excludes Gemini
2.0 models. Confirm current endpoint, selected model, audio/transcription, and
MIME support in an authorized live check before release; Google's examples use
the Interactions API while this project currently uses `generateContent`.
Do not assume the two APIs accept identical payloads.

Previous discussion overstated that external URLs must be public and that YouTube
is the only possible platform-page extractor. Google also documents signed
external URLs, but this plan deliberately passes only verified-public direct
media URLs; it does not rely on support for other platform pages.

The content-hash upload cache cannot avoid a remote download: it needs the
downloaded bytes to calculate the hash. Direct Gemini URL routing avoids the
analyzer's download and upload for eligible inputs instead.

## Recommended approach

Use the existing in-memory Gemini upload-reference cache for immutable local
snapshots and downloaded media in a long-lived service. Add an **opt-in,
persistent reference cache** shared by CLI processes and usable by the MCP
server. Keep persistence disabled unless the user explicitly configures a
cache directory. This avoids silently retaining information about analyzed
media on a shared machine. Gemini URL pass-through does not create an upload
reference and is not part of this cache.

The persistent cache stores only the minimum reference metadata needed for
reuse, not media files, prompts, answers, URLs, cookies, or API keys. Local
inputs require a separate **temporary media snapshot** during each AI
operation, as described below; it is not retained as a download cache.
Metadata such as content hashes and file identifiers can still be sensitive.
Document retention, the cache location, how to disable it, and how to remove
the local cache. Deleting local references does not delete Gemini's uploaded
files.

This corrects the earlier suggestion that persistence is automatically safe:
file references and content hashes need access controls, concurrent updates
need careful handling, and an ACTIVE check alone does not establish that an
untrusted cache entry corresponds to the requested media.

## Requirements

These are plan-local identifiers, inferred from the conversation:

- **REQ-001:** Reuse identical downloaded and local media uploads within a
  process and, when persistence is enabled, across processes, provided a valid
  reference for the same credential scope exists.
- **REQ-002:** Never reuse an upload for different content; handle uncached,
  changed, expired, inaccessible, or concurrently modified inputs safely.
- **REQ-003:** Protect and bound persisted metadata; do not persist media or
  credentials.
- **REQ-004:** Handle concurrent processes and cache failures without corrupting
  references or silently hiding failures.
- **REQ-005:** Explain precisely what is and is not cached and verify the
  behavior with focused tests.
- **REQ-006:** Send eligible public YouTube URLs and eligible public direct
  media URLs of at most 15 MB to Gemini without local media download or upload.
- **REQ-007:** For other supported remote media in AI operations, download with
  yt-dlp and then upload to Gemini or reuse an eligible cached upload. Use
  yt-dlp without Gemini for local-only operations. Keep fallback and errors
  explicit and narrowly classified.
- **REQ-008:** Preserve network, privacy, cancellation, metadata, and operation
  contracts, explicitly documenting unavoidable compatibility changes.

## Direct-routing implementation

### 0.1 Eligibility and safe selection

**Plan 0.1 — REQ-006–REQ-008.** Add a typed AI input decision in
[mediaInput.ts](../../../src/services/mediaInput.ts) and
[shared.ts](../../../src/operations/shared.ts), distinguishing a validated
direct Gemini URL from an owned local media file. Match exact recognized
YouTube hostnames and supported URL forms; never rely on substring matching.
Public/private cannot reliably be inferred from a URL alone: default to the
Gemini path for recognized YouTube URLs unless reliable unauthenticated
metadata establishes ineligibility; if Gemini specifically reports that the
video is inaccessible or unsupported, perform the yt-dlp fallback once.
Do not interpret quota, model, authentication, cancellation, network, safety,
or generic generation errors as proof of private content. Surface those errors.
If yt-dlp also cannot access the content, report the failure with an actionable
hint; cookies are never sent to Gemini.

For direct files, use a bounded, per-hop-validated HTTPS probe without fetching
the full body. Require a supported media MIME type, no URL credentials, and
public accessibility without authentication; conservatively use a maximum of
15,000,000 bytes pending verification of Google's precise definition. Only use
the direct path when an identity-encoded, trustworthy length is available and
at or below the limit. Missing or ambiguous lengths, authentication, signed or
token-bearing URLs, unsupported MIME types, HTTP-only URLs, and other page
URLs go to yt-dlp, followed by Gemini upload or reuse of an eligible cached
upload. This conservative policy may miss some eligible public files; document
that trade-off.

HEAD or range metadata can be wrong or change before Google fetches the URL.
Treat the size check as eligibility, not a hard guarantee; narrowly handle a
confirmed provider size/retrieval rejection without retry loops. A network,
timeout, cancellation, or Gemini API authentication error is not an implicit
fallback.
Honor existing configured download limits on the yt-dlp route; define and
document their applicability to direct Gemini fetching instead of claiming
the local download limit bounds bytes fetched by Google.

### 0.2 Security and transport

**Plan 0.2 — REQ-007, REQ-008.** Preserve URL validation, redirect limits,
timeouts, and redacted diagnostics for probing. Direct Gemini fetching is a
separate trust boundary: the provider follows the URL independently, so a
local DNS or redirect check alone cannot guarantee safety against changes
after validation. Restrict the direct path to inputs that meet the documented
public-URL policy; never forward private-host URLs, credentials, or signed
tokens to Gemini. Keep the private-host opt-in from becoming permission to send
internal URLs to Google.

The current [ytdlp.ts](../../../src/services/ytdlp.ts) documents that yt-dlp
resolves its own network destinations; the existing Node URL guard does not
cover its redirects, derived URLs, or DNS lookups. Replacing the safe direct
downloader with yt-dlp for general URLs must not weaken that boundary. Before
shipping, implement and verify an enforceable per-hop network restriction for
yt-dlp, or reject unsupported cases explicitly; a preflight check of the
initial URL is insufficient. Do not silently bypass this gate for private
videos or when private hosts are allowed.

**Plan 0.3 — REQ-006–REQ-008.** Extend the typed Gemini service and adapter in
[gemini.ts](../../../src/services/gemini.ts) to send the appropriate URL
input without calling `ensureUploaded`. Verify the SDK/endpoint contract
against Google documentation and an authorized integration test before choosing
the request shape. Preserve prompt, model, timeout, cancellation, and explicit
error behavior across direct and upload routes. Do not cache prompts or answers.

### 0.3 Metadata and operation compatibility

**Plan 0.4 — REQ-006, REQ-008.** Refactor all four AI operations to accept
direct inputs without running local `ffprobe`. Current operation results
include `durationSeconds`, timestamp range validation, and sometimes audio
warnings based on probed metadata. Propose `durationSeconds: null` when
unavailable, retain its existing numeric value for local/downloaded files,
skip out-of-range timestamp validation only when duration is unknown, and add
an explicit warning that metadata-based checks were unavailable. Do not invent
duration, audio presence, or timestamps. Preserve transcript target alias
checks against the original local file and retain existing CLI/MCP envelopes.

This changes a result-field type for direct inputs; document it and update
consumer contracts/tests before release. If compatibility policy forbids the
change, resolve the contract with the user rather than secretly downloading
media on the direct route.

## Implementation steps

### 1. Configuration and trust boundary

**Plan 1.1 — REQ-003, REQ-004.** Add an explicit
`VIDEO_ANALYZER_CACHE_DIR` opt-in in [config.ts](../../../src/config.ts).
Resolve it consistently with other paths; do not enable persistence by default.
Treat this as a trusted, user-controlled directory rather than accepting
untrusted repository `.env` configuration without reviewing the existing
configuration trust rules. Use restrictive directory and file permissions,
including an explicit Windows ACL strategy; do not assume POSIX `0600`
enforces privacy on Windows. If the required protection cannot be established,
warn and use the in-memory cache rather than persisting references.

**Plan 1.2 — REQ-001, REQ-003.** Partition references by a stable credential
scope without storing the API key or a directly reusable credential-derived
value. Design and review the local derivation and key storage before coding;
key rotation may safely cause a miss. An injected test/custom `GeminiApi` has
no implicit credential identity: disable persistence for it unless the caller
explicitly supplies a trusted scope.

### 2. Persistent reference store

**Plan 2.1 — REQ-001, REQ-003, REQ-004.** Add a small versioned store near
[gemini.ts](../../../src/services/gemini.ts). Key it by the existing immutable
content identity and credential scope. Store only the file name and expiration,
plus minimal bookkeeping. Never trust a disk-stored URI or MIME type for a
generation request; retrieve fresh file metadata from Gemini.

Bound the number and size of entries; prune expired entries. Follow the
provider's actual expiration when supplied and the existing conservative
47-hour fallback otherwise. Keep the existing 32-entry in-memory LRU.

**Plan 2.2 — REQ-003, REQ-004.** Use validated, bounded reads and atomic
publication in the same directory. Coordinate updates and pruning across
processes with bounded locking or an equivalently safe design; do not rely on
whole-file last-write-wins, which loses unrelated entries. Avoid following
unexpected links or overwriting unrelated files. A race may cause duplicate
uploads, but must never publish a partial or mismatched entry.

Warn on malformed data, unsupported schema, permission failures, or other
store errors; continue with the existing in-memory path when persistence is
unavailable. Never log stored identifiers or secrets unnecessarily. Keep
cancellation and timeout errors visible rather than converting them into
cache misses.

### 3. Integrate with the upload pipeline

**Plan 3.1 — REQ-001, REQ-002, REQ-004.** In
[GeminiMediaService](../../../src/services/gemini.ts), retain the current
in-memory lookup and in-flight coalescing. After a memory miss, look up the
content identity in the persistent store. Call `getFile` using the current
credentials and reuse only a valid, unexpired `ACTIVE` response with the
expected name and compatible MIME type. An unavailable or expired file is a
miss; distinguish that from authentication, transient network, timeout, and
cancellation failures, and surface those errors rather than treating all
failures as misses.

The store must be protected from modification by other users: a valid Gemini
file name alone cannot prove that the referenced upload contains the bytes
associated with a disk cache key.

**Plan 3.2 — REQ-001, REQ-002.** For each local AI input, stream a copy into an
owned, access-restricted temporary snapshot while computing a content hash.
Use that snapshot, not the mutable original path, for both media probing and
the Gemini upload. Derive the cache key from the snapshot's bytes and MIME
type; do not use path, size, or modification time as a content identity.
This keeps the key tied to the bytes actually uploaded, including when a local
file is modified or replaced after snapshot creation.

Open the source safely, detect observable changes during copying and fail
explicitly when detected. Ordinary filesystem checks cannot guarantee a
point-in-time snapshot if another process writes during the copy, so document
that callers must not modify the source while it is being copied. Preserve
the original source path for transcript output-alias checks and never modify
or delete the caller's file. Use the existing retained-source lifetime pattern
so cancellation, concurrent upload sharing, errors, and completion clean up
the snapshot only after the last user releases it. Recover orphaned snapshots
using the existing owned-temp cleanup policy.

Snapshot creation reads the entire local file and temporarily needs disk space
for a copy even on a cache hit. Surface copy, space, and permission errors;
do not silently reuse an unverified file. Apply this work only to AI operations,
not metadata or frame-extraction operations.

**Plan 3.3 — REQ-001, REQ-002.** After a successful upload becomes `ACTIVE`,
publish its reference and expiration. If persistence fails, report a warning;
the successful upload and existing in-memory behavior remain usable. Cache
local uploads only by their snapshot's content identity, never by the mutable
original path. Preserve temporary-source retention and cleanup for concurrent
in-process uploads.

### 4. Verification and documentation

**Plan 4.1 — REQ-001–REQ-008.** Extend the existing Gemini, media-input,
network, operation, adapter, and configuration tests and add focused store
tests. Use isolated temporary directories and a fake Gemini API; exercise two
fresh services or processes sharing a store.
Verify identical local and remote content reuses a reference after an ACTIVE
check without a second upload, both within one service and across fresh
services with persistence enabled. Verify that changed local bytes, including
a same-size rewrite with preserved modification time, miss the cache; a source
changed after snapshot creation must not change the snapshot being uploaded.
Cover expiry, provider deletion, different credential scope, concurrent
requests and writes, snapshot copy failures, cancellation, transient errors,
and malformed or inaccessible storage. Confirm that persisted records contain
neither credentials nor media, that snapshots are cleaned up, that the original
file is never removed, and that transcript output cannot overwrite it.

Add routing tests for each AI operation: public YouTube and known-small direct
HTTPS files make a Gemini URL request without media download or upload; private
or unlisted YouTube uses yt-dlp followed by Gemini upload or cache reuse after
a specifically classified provider ineligibility response; large/unknown-size
files and other platforms follow the same download-then-upload-or-reuse route.
Cover the exact size boundary, redirects, false YouTube hostnames,
ambiguous or changing lengths, MIME types, authenticated/signed URLs, missing
yt-dlp, fallback failures, and provider quota, timeout, cancellation, and safety
errors. Assert local-only operations still download remote media and never
require Gemini. Test SSRF protections against redirects, rebinding, and
yt-dlp-derived destinations, including private-host opt-in.

Verify direct-result metadata is null with a warning and timestamp checks are
skipped only when duration is unknown; retain existing output and checks on
downloaded/local paths. Run a separately authorized live test with public
YouTube and small direct media, including an audio/transcription case, using
the configured SDK, endpoint, and supported model; never send private media or
credentials to an unrelated service. If live validation is unavailable, report
the unverified compatibility rather than claiming success.

**Plan 4.2 — REQ-003, REQ-005–REQ-008.** Update
[README.md](../../../README.md) and
[configuration.md](../../../skills/video-analyzer/references/configuration.md)
along with relevant skill operation and troubleshooting documentation. Explain
routing, direct-URL eligibility, provider preview/limits and independent fetch,
yt-dlp requirements and security restrictions, nullable metadata, opt-in cache
setup, local snapshot disk and privacy implications, retention, deletion, and
Windows permission behavior. Run the focused tests, `npm run typecheck`, and
the relevant existing lint/build checks.

## Tasks

- [ ] T001 [Plan:0.1,0.2] Implement and test safe input classification,
      direct-file probing, and enforceable yt-dlp network restrictions.
- [ ] T002 [Plan:0.3,0.4] Integrate Gemini URL requests and explicit nullable
      metadata into all AI operations while retaining local-only operation flow.
- [ ] T003 [Plan:1.1,1.2] Finalize the opt-in configuration, Windows privacy
      strategy, and credential-scope design before implementation.
- [ ] T004 [Plan:2.1,2.2] Implement the bounded, versioned reference store with
      safe cross-process publication, pruning, and explicit error reporting.
- [ ] T005 [Plan:3.1,3.3] Integrate the store into the shared Gemini upload
      pipeline, preserving remote-media cleanup and in-process coalescing.
- [ ] T006 [Plan:3.2,3.3] Add content-hashed local snapshots for AI inputs;
      preserve source protection, snapshot retention, and cleanup.
- [ ] T007 [Plan:4.1] Test routes, boundary cases, reuse, safety, failure
      handling, metadata, local snapshots, concurrency, and cleanup; run
      applicable checks and authorized live validation.
- [ ] T008 [Plan:4.2] Document routing, configuration, limits, and cleanup.

## Requirement mapping

| Requirement | Plan items                   | Evidence of completion                                   |
| ----------- | ---------------------------- | -------------------------------------------------------- |
| REQ-001     | 1.2, 2.1, 3.1, 3.2, 3.3, 4.1 | Store, snapshots, Gemini service, and reuse tests        |
| REQ-002     | 3.1, 3.2, 3.3, 4.1           | Snapshot, miss, original-file protection, cleanup tests  |
| REQ-003     | 1.1, 1.2, 2.1, 2.2, 4.1, 4.2 | Configuration, store, privacy tests, documentation       |
| REQ-004     | 1.1, 2.1, 2.2, 3.1, 4.1      | Store and Gemini service; concurrency and failure tests  |
| REQ-005     | 0.3, 4.1, 4.2                | Focused tests and user documentation                     |
| REQ-006     | 0.1, 0.3, 0.4, 4.1, 4.2      | Input routing, Gemini service, direct-path tests         |
| REQ-007     | 0.1, 0.2, 0.3, 4.1, 4.2      | Downloader, fallback, local-operation and security tests |
| REQ-008     | 0.1, 0.2, 0.3, 0.4, 4.1, 4.2 | Operations, adapters, error, metadata and security tests |

## Deferred: media-download cache

Do not implement a media cache as part of this plan. Consider a separate
opt-in design if measurements show repeated downloads are a meaningful
bottleneck. It would need its own privacy and authorization policy, bounded
disk usage and retention, freshness rules, concurrency controls, and safe
handling of URLs, redirects, cookies, and changed download settings.

A URL or platform ID could act as a lookup key for a media cache, while a
content hash verifies the downloaded object. The hash alone cannot identify
new remote bytes before fetching them; it does not preclude a URL-indexed
cache. Until such a feature exists, users can download once themselves and
pass the local file path to avoid repeated downloads on the yt-dlp route.
