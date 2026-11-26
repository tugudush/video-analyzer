# Codebase Review: `video-analyzer`

**Date:** 2026-11-26  
**Scope:** Full repository review (`src/`, `skills/`, `tests/`, `docs/`, configuration, and build/test tooling)  
**Baseline Check:** `npm run check` (`tsc --noEmit`, `oxlint`, `tsc -p tsconfig.build.json`, `vitest run`, `prettier --check .`) — **passed** (29 test files passed, 430 tests passed, 2 skipped: live Gemini smoke test and privilege-gated symlink test on Windows).

---

## Executive Summary

`video-analyzer` is a well-structured, disciplined TypeScript (ESM, Node >= 22) toolkit that exposes six media operations (`analyze_video`, `summarize_video`, `search_timestamp`, `transcribe_video`, `get_video_info`, `extract_frames`) through two structurally parity-enforced interfaces: an MCP server over stdio and a CLI used directly or via an Agent Skill.

Strengths are notably high in defensive engineering: SSRF protection with DNS pinning and a loopback egress proxy for `yt-dlp`, atomic and race-safe transcript writes, content-hashed local snapshots to avoid TOCTOU upload-cache poisoning, bounded cancellation/timeouts (`AbortSignal` + timer clamping + `AsyncLocalStorage` upload fetch wrapping), and clean structural parity between CLI and MCP adapters.

The review identified **2 concrete functional bugs**, **4 moderate edge-case / reliability / performance issues**, and **4 documentation / tooling gaps** detailed below.

> **Resolution Update (2026-11-26):** Findings **#1–#9** have been resolved and covered by regression tests; Finding **#10** (`oxlint` vs `typescript-eslint` on TS 7) remains a tracked ecosystem constraint. Post-remediation `npm run check` passes (**29/30 test files, 439 passed, 2 skipped**).

---

## Architecture & Strengths

1. **Single Registry, Structural Parity**
   - [registry.ts](../../src/operations/registry.ts) defines `OPERATIONS` once; [mcpTools.ts](../../src/adapters/mcpTools.ts) and [cli.ts](../../src/adapters/cli.ts) both iterate it, sharing exact Zod schemas, titles, descriptions, and `readOnly`/`destructive` hints.
   - [parity.test.ts](../../tests/contract/parity.test.ts) enforces schema object identity, tool metadata, and exclusion of generative/licensing capabilities.

2. **SSRF & Network Defense in Depth**
   - [net.ts](../../src/utils/net.ts) (`resolveSafeHttpUrl`, `fetchPinned`, `downloadToFile`) validates each redirect hop independently, blocks private/loopback/link-local/NAT64/embedded-IPv4 addresses, rejects embedded URL credentials, and binds `undici` `Agent` custom `lookup` to the pre-validated IP addresses while keeping hostname SNI for TLS.
   - [egressGuard.ts](../../src/services/egressGuard.ts) and [ytdlp.ts](../../src/services/ytdlp.ts) route `yt-dlp` traffic through a loopback HTTP/CONNECT proxy so page-discovered CDN/media hosts cannot bypass private-host rules, and `--ignore-config` blocks user `yt-dlp` config injection (e.g., `--exec`).
   - `redactUrlsInText` in [net.ts](../../src/utils/net.ts) strips query strings and credentials before subprocess stderr reaches errors or logs.

3. **Upload Caching & Concurrency Safety**
   - [localSnapshot.ts](../../src/services/localSnapshot.ts) copies local AI inputs into an owned temp directory while computing SHA-256 and verifies size/mtime stability, preventing mutable-file TOCTOU mismatches.
   - [gemini.ts](../../src/services/gemini.ts) (`GeminiMediaService.ensureUploaded`) coalesces concurrent uploads by content `cacheKey`, retains the source via reference counting until upload finishes, and verifies `ACTIVE` state via `files.get` before reusing cached or persisted handles.
   - [uploadCache.ts](../../src/services/uploadCache.ts) (`FileUploadReferenceStore`) partitions persisted references by API-key fingerprint (`credentialScope`), uses `wx` file locking with stale-lock recovery, merges on-disk state before atomic rename, and stores only handle metadata (no media/prompts/keys).

4. **Cancellation, Timeouts, and Safe File Operations**
   - [abort.ts](../../src/utils/abort.ts) (`runWithBounds`, `clampTimerMs`) prevents Node's 32-bit `TimeoutOverflowWarning` 1 ms clamp and races deadlines/abort signals against hung client calls.
   - [gemini.ts](../../src/services/gemini.ts) works around `@google/genai`'s upload abort-signal gap using `AsyncLocalStorage`-scoped `fetch` wrapping (`withUploadSignal`).
   - [transcribeVideo.ts](../../src/operations/transcribeVideo.ts) validates `outputPath` before upload, checks symlink/hardlink source aliasing (`isSameFile` in [fsUtils.ts](../../src/utils/fsUtils.ts)), uses atomic `wx` writes or staged directory replacement on `overwrite: true`, and refuses `.srt`/`.vtt` fabrication.
   - [invoke.mjs](../../skills/video-analyzer/scripts/invoke.mjs) safely streams payloads over stdin (avoiding Windows 32 KiB `cmd.exe` limits and shell metacharacter mangling on `.cmd` shims).

---

## Findings

| #   | Severity | Summary                                                                          | Status       |
| --- | -------- | -------------------------------------------------------------------------------- | ------------ |
| 1   | High     | Plain-HTTP `egressGuard` header/body compression mismatch                        | Resolved     |
| 2   | High     | `search_timestamp` single-timestamp regex misparses `MM:SS`                      | Resolved     |
| 3   | Medium   | Local AI calls copy whole file to `tmpdir()` even on cache hits                  | Resolved     |
| 4   | Medium   | `resolveDirect` passes `finalUrl` instead of original `url` on HTML redirects    | Resolved     |
| 5   | Medium   | `CONNECT` single-address fallback & `downloadToFile` extra redirect validation   | Resolved     |
| 6   | Medium   | `extract_frames` sequential subprocesses & decoded-from-0 EOF fallback           | Resolved     |
| 7   | Low      | `VIDEO_ANALYZER_CACHE_DIR` missing from `CLI_USAGE` and `.env.example`           | Resolved     |
| 8   | Low      | `docs/features/caching/progress.md` out of date                                  | Resolved     |
| 9   | Low      | Minor CLI flag conflict, `outputPath` schema, and `SKILL.md` frontmatter gaps    | Resolved     |
| 10  | Low      | `oxlint` lacks type-aware promise rules (`typescript-eslint` lacks TS 7 support) | Not resolved |

### High / Functional Bugs

#### 1. Plain-HTTP `egressGuard` forwards compressed-response headers for an already-decompressed body — `[RESOLVED]`

- **Status:** **Resolved.** `filterHeaders` now sets `'accept-encoding': 'identity'` and `responseHeaders` strips `content-encoding` and `content-length` whenever `undici` decoded a non-identity response. Covered by [egressGuard.test.ts](../../tests/unit/egressGuard.test.ts).
- **Location:** [egressGuard.ts](../../src/services/egressGuard.ts:43-66), [egressGuard.ts](../../src/services/egressGuard.ts:154-179)
- **Details:** `filterHeaders` strips `accept-encoding` from incoming client requests before calling `fetchPinned` (`undici.fetch`). When `accept-encoding` is omitted, `undici` automatically injects `accept-encoding: gzip, deflate, br`, transparently decompresses the response stream in `response.body`, **yet retains `content-encoding` and the compressed `content-length` in `response.headers`**. `responseHeaders()` then copies both headers verbatim onto the `ServerResponse` while piping the decompressed bytes.
- **Impact:** Any plain-HTTP (`http://`) response compressed with `gzip`/`deflate`/`br` relayed through `yt-dlp`'s proxy will advertise `Content-Encoding: gzip` (and a mismatched `Content-Length`) over plain decompressed bytes, causing `yt-dlp` to fail decompression or truncate reads. (HTTPS traffic uses `CONNECT` tunneling and is unaffected.)
- **Recommendation:** Either set `'accept-encoding': 'identity'` in `filterHeaders` (preventing upstream compression on plain-HTTP proxied calls) or strip `content-encoding` and `content-length` in `responseHeaders` when `content-encoding` was decoded by `undici`.

#### 2. `search_timestamp` single-timestamp regex misparses `MM:SS` as `MM` seconds — `[RESOLVED]`

- **Status:** **Resolved.** Updated the single-timestamp regex in `parseTimestampMatches` to require whitespace, dash, end-of-line, or `:` not followed by a digit. Covered by [searchTimestamp.test.ts](../../tests/unit/searchTimestamp.test.ts).
- **Location:** [searchTimestamp.ts](../../src/operations/searchTimestamp.ts:45-56)
- **Details:** The two-timestamp regex requires a boundary after the second number (`(?=\s|[-–—:]|$)`), but the single-timestamp fallback regex does not:
  ```ts
  const single = line.match(/^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)\s*(?:[-–—:]\s*)?(.*)$/i)
  ```
  Because `\s*` and `(?:[-–—:]\s*)?` are both optional, a model reply that slips into `MM:SS` format—such as `MATCH 01:23 — speaker enters`—matches `01` as `startSeconds: 1`, consumes `:` as separator, and sets `description` to `"23 — speaker enters"`.
- **Impact:** Silent timestamp corruption (reporting `00:00:01.000` instead of `00:01:23.000` or falling back to raw prose).
- **Recommendation:** Require whitespace, an en/em-dash/hyphen, or end-of-line after the number (e.g. `(?=\s|[-–—]|$)` and disallow `:` directly followed by digits without whitespace), so `01:23` is either rejected into the raw-answer fallback or explicitly parsed as `MM:SS`.

---

### Medium / Edge Cases, Performance, and Reliability

#### 3. Local AI calls always copy the entire media file into `tmpdir()`, even on cache hits or single-shot CLI runs — `[RESOLVED]`

- **Status:** **Resolved.** Added `hasPotentialCacheHits`, `findReusableUpload`, `generateWithHandle`, and streaming in-place `hashLocalFile` so cache hits reuse active Gemini files with zero `tmpdir()` copy, while cache misses create one snapshot. Covered by [aiRouting.test.ts](../../tests/unit/aiRouting.test.ts).
- **Location:** [shared.ts](../../src/operations/shared.ts:176-225), [localSnapshot.ts](../../src/services/localSnapshot.ts:38-88)
- **Details:** `resolveAiMedia` copies every local input in full via `createLocalSnapshot` to compute a SHA-256 hash before checking the in-memory or on-disk upload cache (`VIDEO_ANALYZER_CACHE_DIR`).
- **Impact:**
  1. For large local videos (hundreds of MB to multi-GB), every AI call—including cache hits and single-shot CLI invocations where `cacheDir` is unset and no cross-process reuse can occur—pays a full disk copy into the OS temp directory.
  2. Unlike remote downloads (bounded by `VIDEO_ANALYZER_DOWNLOAD_MAX_MB`), there is no size check before copying a local file into `tmpdir()`.
- **Recommendation:** Skip creating a temp copy when neither in-memory reuse nor `cacheDir` applies (or hash in-place for cache lookup and only snapshot on cache miss before upload, re-verifying file stability/hash during upload). Consider honoring a disk budget or streaming directly when caching is inactive.

#### 4. `resolveDirect` passes `result.finalUrl` instead of original `url` to `yt-dlp` on HTML responses — `[RESOLVED]`

- **Status:** **Resolved.** `resolveDirect` tries `result.finalUrl` first (preserving link shorteners) and falls back to the original `url` if `downloadFromPlatform` fails with `UNSUPPORTED_INPUT` or `DOWNLOAD_FAILED`. Covered by [mediaInput.test.ts](../../tests/unit/mediaInput.test.ts).
- **Location:** [mediaInput.ts](../../src/services/mediaInput.ts:171-205) vs. [mediaInput.ts](../../src/services/mediaInput.ts:127)
- **Details:** When `downloadToFile` receives a 401/403/407/429 refusal, `downloadPageAfterRefusal` hands the original `url` to `downloadFromPlatform(url, ...)`. However, when `downloadToFile` follows redirects and lands on a `200 OK` HTML page (`pageLike === true`), `resolveDirect` passes `result.finalUrl` to `downloadFromPlatform`.
- **Impact:** If an unauthenticated `downloadToFile` probe is redirected by a platform to a login, age-gate, or consent page (e.g. `https://example.com/login?...` returning `200 text/html`), `yt-dlp` is invoked on the login/consent URL rather than the original media page URL—defeating `YT_DLP_COOKIES_FILE` or `YT_DLP_IMPERSONATE`.
- **Recommendation:** Pass the original `url` (or fall back to `url` when `result.finalUrl` differs by host/path) when handing a page off to `downloadFromPlatform`.

#### 5. `egressGuard` `CONNECT` tunnel connects only to `addresses[0]` without dual-stack fallback; `downloadToFile` validates one extra redirect hop — `[RESOLVED]`

- **Status:** **Resolved.** Added `connectValidated` in `egressGuard` to fall back across all validated addresses, and enforced `redirects >= MAX_REDIRECTS` in `downloadToFile` before validating the next `Location`. Covered by [egressGuard.test.ts](../../tests/unit/egressGuard.test.ts) and [net.test.ts](../../tests/unit/net.test.ts).
- **Location:** [egressGuard.ts](../../src/services/egressGuard.ts:107-130), [net.ts](../../src/utils/net.ts:431-489)
- **Details:**
  - `validateAuthority` in `egressGuard.ts` returns only `resolved.addresses[0]`. On hosts where DNS returns an IPv6 `AAAA` record first but outbound IPv6 connectivity is unavailable or blocked, `connect(target.port, target.address)` fails with `502 Bad Gateway` instead of trying remaining validated addresses.
  - In `downloadToFile` (`net.ts:431`), the loop runs `for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++)`, so on the `MAX_REDIRECTS`-th redirect it resolves/validates the `(MAX_REDIRECTS + 1)`-th `Location` URL before exiting the loop and throwing `Too many redirects`.
- **Recommendation:** Try validated `addresses` sequentially (or with Node's `autoSelectFamily`-style fallback restricted to the validated list) in `tunnel()`, and check `redirects >= MAX_REDIRECTS` before calling `validate(next.href)` in `downloadToFile` (matching `fetchPinned`).

#### 6. Sequential subprocess spawning in `extract_frames` (`timestamps` & `scene`) and decoded-from-0 EOF fallback — `[RESOLVED]`

- **Status:** **Resolved (EOF fallback optimized; sequential O(1) keyframe-seeking retained).** Added lazy `getVideoStreamDuration` probing on EOF fallback so long clips with trailing audio seek near the end of the video stream instead of decoding from `t=0` (with fallback to `0` if needed).
- **Location:** [ffmpeg.ts](../../src/services/ffmpeg.ts:434-580), [ffmpeg.ts](../../src/services/ffmpeg.ts:588-652)
- **Details:**
  - `extractFramesAtTimestamps` spawns one `ffmpeg` process per timestamp, and `extractSceneFrames` calls it for up to 200 detected scenes (up to 201 sequential process spawns for a single `extract_frames` call).
  - When `-ss <timestamp>` produces no frame near EOF (e.g., audio track extends past last video frame), the fallback command omits `-ss` and applies `tpad=...:fps=1000:start_time=...`, decoding the entire video from `t=0`.
- **Impact:** High process-spawn latency on Windows and potential `FFMPEG_TIMEOUT_MS` timeouts on long videos when seeking near the end. (This trade-off is acknowledged in [operations.md](../../skills/video-analyzer/references/operations.md).)

---

### Low / Documentation, CLI UX, and Tooling Gaps

#### 7. `VIDEO_ANALYZER_CACHE_DIR` is missing from CLI help (`CLI_USAGE`) and `.env.example` — `[RESOLVED]`

- **Status:** **Resolved.** Added `VIDEO_ANALYZER_CACHE_DIR` to `CLI_USAGE` (including the `.env` exclusion note) and `.env.example`.
- **Location:** [cli.ts](../../src/adapters/cli.ts:89-118), [.env.example](../../.env.example:21-30)
- **Details:** `VIDEO_ANALYZER_CACHE_DIR` is implemented in [config.ts](../../src/config.ts:183) (environment-only, excluded from `DOTENV_KEYS`) and documented in [README.md](../../README.md:451) and [configuration.md](../../skills/video-analyzer/references/configuration.md:111), but is absent from both `CLI_USAGE` (and its `.env` exclusion summary) and `.env.example`.

#### 8. `docs/features/caching/progress.md` is out of date — `[RESOLVED]`

- **Status:** **Resolved.** Updated [progress.md](../features/caching/progress.md) to mark `0.2` (`egressGuard.ts`) done and reflect current implementation and test counts.
- **Location:** [progress.md](../features/caching/progress.md)
- **Details:** Still lists `yt-dlp per-hop network restriction` (`0.2`) as `not done` and reports `389 passing, 2 skipped` tests. Since then, [egressGuard.ts](../../src/services/egressGuard.ts) and [ytdlp.ts](../../src/services/ytdlp.ts) implemented the loopback proxy guard and the suite grew to `430 passing, 2 skipped`.

#### 9. Minor CLI / Schema / Skill metadata inconsistencies — `[RESOLVED]`

- **Status:** **Resolved.** Rejected `--input` + `--input-file` together and unexpected positional args on operation commands in `cli.ts`, tightened `outputPath` to `z.string().trim().min(1).optional()` in `transcribeVideo.ts`, and added platform page URLs to `SKILL.md` frontmatter description. Covered by [cli.test.ts](../../tests/unit/cli.test.ts) and [transcribeVideo.test.ts](../../tests/unit/transcribeVideo.test.ts).
- **Location:** [cli.ts](../../src/adapters/cli.ts:210-241), [cli.ts](../../src/adapters/cli.ts:320-335), [transcribeVideo.ts](../../src/operations/transcribeVideo.ts:25), [SKILL.md](../../skills/video-analyzer/SKILL.md:3-5)
- **Details:**
  - `cli.ts`: Passing both `--input` and `--input-file` silently favors `--input-file`; extra positional args on operation commands (`parsed.rest`) are silently ignored.
  - `transcribeVideo.ts`: `outputPath: z.string().optional()` lacks `.min(1)`, so `outputPath: ""` is silently ignored while `outputPath: "   "` resolves to `cwd` and errors as a directory.
  - `SKILL.md`: Frontmatter `description` mentions `local paths, file:// URIs, and direct http(s) media URLs` without mentioning platform page URLs (`yt-dlp`), though the body (`SKILL.md:30`) documents them.

#### 10. Linting gap (documented): `oxlint` lacks type-aware promise rules — `[NOT RESOLVED]`

- **Status:** **Not resolved (external ecosystem constraint).** `typescript-eslint@8` still does not support TypeScript 7 (`typescript: ^7.0.2`), so the repository retains `oxlint` with explicit `void` prefixes and `tsc --strict` until upstream TS 7 support lands.
- **Location:** [.oxlintrc.json](../../.oxlintrc.json), [README.md](../../README.md:519-527)
- **Details:** Because `typescript-eslint@8` does not yet support TypeScript 7 (`typescript: ^7.0.2`), the repo uses `oxlint`, which skips type-aware rules such as `no-floating-promises` and `no-misused-promises`. The codebase compensates well with `void` prefixes and `tsc --strict`, and already notes the planned migration path.

---

## Verification & Test Coverage Assessment

| Check     | Command                | Outcome | Notes                                                                                                                                                                                                |
| --------- | ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck | `npm run typecheck`    | Pass    | `tsc --strict` across `src/` and `tests/`                                                                                                                                                            |
| Lint      | `npm run lint`         | Pass    | `oxlint src tests skills`                                                                                                                                                                            |
| Build     | `npm run build`        | Pass    | Emits `dist/` before tests                                                                                                                                                                           |
| Tests     | `npm test`             | Pass    | 29/30 files, 439 passed, 2 skipped ([liveGemini.test.ts](../../tests/integration/liveGemini.test.ts), symlink privilege case in [transcribeVideo.test.ts](../../tests/unit/transcribeVideo.test.ts)) |
| Format    | `npm run format:check` | Pass    | `prettier --check .`                                                                                                                                                                                 |

**Notable test coverage gaps (updated):**

- **Live Gemini URL routing (`generateWithUrl`):** Tested with mocked `GeminiApi` and local HTTP servers in [aiRouting.test.ts](../../tests/unit/aiRouting.test.ts) and [mediaRouting.test.ts](../../tests/unit/mediaRouting.test.ts), but [liveGemini.test.ts](../../tests/integration/liveGemini.test.ts) only tests a local generated clip—real YouTube/direct-URL `fileData.fileUri` requests and `isDirectUrlRejection` error strings from the live Gemini endpoint remain unverified against production.
- **Resolved during remediation:** Compressed plain-HTTP `egressGuard` relays and `CONNECT` multi-address fallback ([egressGuard.test.ts](../../tests/unit/egressGuard.test.ts)), `search_timestamp` `MM:SS` handling ([searchTimestamp.test.ts](../../tests/unit/searchTimestamp.test.ts)), cache-hit snapshot skipping ([aiRouting.test.ts](../../tests/unit/aiRouting.test.ts)), HTML login-redirect `yt-dlp` fallback ([mediaInput.test.ts](../../tests/unit/mediaInput.test.ts)), redirect-limit DNS boundary ([net.test.ts](../../tests/unit/net.test.ts)), CLI `--input`/`--input-file`/positional validation ([cli.test.ts](../../tests/unit/cli.test.ts)), and blank `outputPath` schema rejection ([transcribeVideo.test.ts](../../tests/unit/transcribeVideo.test.ts)).
