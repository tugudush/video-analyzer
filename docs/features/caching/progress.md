# Implementation progress

Tracks work against [plan.md](./plan.md). Updated as each area lands.

_Last update: implementation pass 1 — code, tests, and docs. Full suite green._

## Status

| Area                                             | Plan items                   | State                                      |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------ |
| Input routing (YouTube / direct file / download) | 0.1                          | done                                       |
| Gemini URL request support                       | 0.3                          | done (unit-tested; not live-validated)     |
| Nullable metadata for direct inputs              | 0.4                          | done                                       |
| Local content-hashed snapshots                   | 3.2                          | done                                       |
| Persistent upload-reference cache                | 1.1, 1.2, 2.1, 2.2, 3.1, 3.3 | done (opt-in)                              |
| yt-dlp per-hop network restriction               | 0.2                          | **not done** — see Open items              |
| Authorized live validation                       | 4.1                          | **not done** — see Open items              |
| Tests and documentation                          | 4.1, 4.2                     | done for everything except live validation |

## What landed

- `src/services/mediaRouting.ts` — exact-host YouTube detection (no substring
  matching, no non-default ports, no credentials), a metadata-only HEAD probe
  with per-hop URL validation, and `classifyAiInput`. A `.mp4` path that answers
  `text/html` is treated as a page, not media.
- `src/services/gemini.ts` — `generateWithUrl`, an optional `mimeType` on file
  parts (omitted for YouTube, which Google rejects when typed), and optional
  persistent-store lookup that re-reads the file and requires `ACTIVE` plus a
  matching MIME type before reuse.
- `src/services/localSnapshot.ts` — copies a local file into an owned temp
  directory while hashing it, rejects a file that changed during the copy, and
  reference-counts cleanup so a coalesced upload cannot lose its source.
- `src/services/uploadCache.ts` — bounded, versioned, lock-guarded store that
  re-reads and merges before writing. Persists only file name, MIME type, and
  expiry; partitions by a one-way credential fingerprint.
- `src/operations/shared.ts` — `withAiMedia` centralises routing, snapshotting,
  generation, the one-shot download fallback, and cleanup for all four AI
  operations.
- `src/config.ts` — `VIDEO_ANALYZER_CACHE_DIR`, deliberately excluded from
  `DOTENV_KEYS` so a repository `.env` cannot redirect retained metadata.
- All four AI operations now report `durationSeconds: null` plus an explicit
  warning when the provider fetched the media itself, and `search_timestamp`
  skips past-the-end checks only when the duration is unknown.

Tests: `mediaRouting`, `localSnapshot`, `uploadCache`, `aiRouting`, plus
persistence and SDK-payload cases in `geminiService`. 389 passing, 2 skipped
(the live Gemini test). `npm run check` — typecheck, lint, tests, format — is
green.

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
2. **Plan 0.2 partially delivered.** URL validation for the probe, and the
   refusal to forward credentials/private hosts to Gemini, are implemented. The
   requirement to add an _enforceable per-hop network restriction for yt-dlp_ is
   not, and is not something that can be bolted on safely without a sandbox or a
   proxy. See Open items.

## Open items

- **Plan 0.2 gate.** yt-dlp still resolves its own destinations beyond the URL
  the tool validated. This is pre-existing behaviour, documented in the README,
  not a regression — but the plan asks for it to be closed before the routing
  changes ship. Options: a validating local proxy, an OS-level sandbox, or
  restricting yt-dlp to an explicit allowlist of extractors.
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
- **Snapshot cost.** Every AI call on a local file now copies the whole file,
  even on a cache hit. That is the price of a trustworthy content key; it should
  be measured on multi-GB inputs before this is called free.
