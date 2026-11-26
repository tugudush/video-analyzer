# Implementation progress

Tracks work against [plan.md](./plan.md). Updated as each area lands.

_Last update: review remediation pass — egress guard, cache-hit snapshot skip, and docs updated. Full suite green._

## Status

| Area                                             | Plan items                   | State                                      |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------ |
| Input routing (YouTube / direct file / download) | 0.1                          | done                                       |
| Gemini URL request support                       | 0.3                          | done (unit-tested; not live-validated)     |
| Nullable metadata for direct inputs              | 0.4                          | done                                       |
| Local content-hashed snapshots                   | 3.2                          | done (skipped on cache hits)               |
| Persistent upload-reference cache                | 1.1, 1.2, 2.1, 2.2, 3.1, 3.3 | done (opt-in)                              |
| yt-dlp per-hop network restriction               | 0.2                          | done (`src/services/egressGuard.ts`)       |
| Authorized live validation                       | 4.1                          | **not done** — see Open items              |
| Tests and documentation                          | 4.1, 4.2                     | done for everything except live validation |

## What landed

- `src/services/mediaRouting.ts` — exact-host YouTube detection (no substring
  matching, no non-default ports, no credentials), a metadata-only HEAD probe
  with per-hop URL validation, and `classifyAiInput`. A `.mp4` path that answers
  `text/html` is treated as a page, not media.
- `src/services/egressGuard.ts` & `src/services/ytdlp.ts` — loopback HTTP/CONNECT
  egress proxy that enforces per-hop SSRF validation and address pinning for all
  requests `yt-dlp` makes, requests `identity` encoding on plain-HTTP relays,
  and falls back across validated addresses for `CONNECT` tunnels.
- `src/services/gemini.ts` — `generateWithUrl`, an optional `mimeType` on file
  parts (omitted for YouTube, which Google rejects when typed), and optional
  persistent-store lookup that re-reads the file and requires `ACTIVE` plus a
  matching MIME type before reuse.
- `src/services/localSnapshot.ts` — copies a local file into an owned temp
  directory while hashing it, rejects a file that changed during the copy, and
  reference-counts cleanup so a coalesced upload cannot lose its source.
  `hashLocalFile` hashes in-place so cache hits skip creating a temp snapshot.
- `src/services/uploadCache.ts` — bounded, versioned, lock-guarded store that
  re-reads and merges before writing. Persists only file name, MIME type, and
  expiry; partitions by a one-way credential fingerprint.
- `src/operations/shared.ts` — `withAiMedia` centralises routing, cache-hit
  in-place hashing, snapshotting on misses, generation, the one-shot download
  fallback, and cleanup for all four AI operations.
- `src/config.ts` — `VIDEO_ANALYZER_CACHE_DIR`, deliberately excluded from
  `DOTENV_KEYS` so a repository `.env` cannot redirect retained metadata.
- All four AI operations now report `durationSeconds: null` plus an explicit
  warning when the provider fetched the media itself, and `search_timestamp`
  skips past-the-end checks only when the duration is unknown.

Tests: `mediaRouting`, `localSnapshot`, `uploadCache`, `aiRouting`, `egressGuard`,
plus persistence and SDK-payload cases in `geminiService`. 439 passing, 2 skipped
(the live Gemini test and privilege-gated symlink test on Windows). `npm run check` —
typecheck, lint, tests, format — is green.

References are flushed before an operation returns, so a CLI process that exits
as soon as its event loop drains still persists them; `aiRouting` covers that by
reusing an upload in a second, independent service.

## Deviations from the plan

1. **Direct media files over 15 MB use the existing downloader, not yt-dlp.**
   The plan said "everything else" runs through yt-dlp. Direct media URLs that
   are confirmed media but too large (or of unknown size) are fetched by the
   already-hardened `downloadToFile`, which keeps per-hop SSRF validation and
   existing behaviour. Platform _page_ URLs still go to yt-dlp exactly as
   before. Routing a direct media URL through yt-dlp would weaken the network
   boundary for no benefit. Say so if the intent was literal.

## Open items

- **Live validation.** Google's examples use the Interactions API; this project
  uses `generateContent`. The `fileData.fileUri` shape is unit-tested but has not
  been exercised against the real endpoint. Needs `GEMINI_API_KEY` and a public
  YouTube URL.
- **Fallback classification.** `isDirectUrlRejection` matches on error text and
  is deliberately conservative. It should be checked against real provider
  messages for private/unlisted videos; until then a misclassification surfaces
  as a visible error rather than a silent download.
- **Windows privacy.** Directory/file modes are `0700`/`0600`, which Windows
  ignores. Placement under `%LOCALAPPDATA%` inherits the user ACL; there is no
  explicit ACL hardening yet.
- **Snapshot cost on cache misses.** Cache hits now hash in-place with zero
  temp-directory copy; initial uncached AI calls on a local file still snapshot
  the file to guarantee the uploaded bytes match the content-hashed cache key.
